/**
 * A session thread is a list of interactions: one message of the trusted user plus the bot
 * messages that follow it. These tests pin how a thread is grouped, which interactions a prune
 * may take, and what the replacement header looks like.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_SUMMARY_CHARS,
  type ThreadIdentity,
  type ThreadMessage,
  buildSummaryPrompt,
  buildThreadHeader,
  chunkTranscripts,
  deriveTitle,
  groupInteractions,
  interactionMessages,
  interactionTranscript,
  messageAuthor,
  normalizeSummary,
  normalizeTitle,
  planDeletions,
  slackTsAtOrBefore,
  slackTsFromMs,
  selectInteractionsToPrune,
} from '../../src/slack/thread-history';

const TRUSTED = 'U0TRUSTED1';
const BOT = 'U0BOTUSER1';
const identity: ThreadIdentity = { trustedUserId: TRUSTED, botUserId: BOT, botId: 'B0BOTID001' };
const THREAD = '1760000000.000100';

let counter = 0;
const nextTs = () => `${1760000001 + counter++}.000100`;
const user = (text: string, extra: Partial<ThreadMessage> = {}): ThreadMessage => ({ ts: nextTs(), user: TRUSTED, thread_ts: THREAD, text, ...extra });
const bot = (text: string, extra: Partial<ThreadMessage> = {}): ThreadMessage => ({ ts: nextTs(), user: BOT, bot_id: 'B0BOTID001', thread_ts: THREAD, text, ...extra });
const botRoot = (text = 'root'): ThreadMessage => ({ ts: THREAD, user: BOT, bot_id: 'B0BOTID001', thread_ts: THREAD, text });
const userRoot = (text = 'first question'): ThreadMessage => ({ ts: THREAD, user: TRUSTED, thread_ts: THREAD, text });
const labels = (messages: ThreadMessage[]) => messages.map((message) => message.text);

describe('who wrote a message', () => {
  it('tells the trusted user, the bridge and everyone else apart', () => {
    expect(messageAuthor(user('hi'), identity)).toBe('user');
    expect(messageAuthor(bot('hello'), identity)).toBe('bot');
    expect(messageAuthor({ ts: nextTs(), bot_id: 'B0BOTID001', text: 'by bot id only' }, identity)).toBe('bot');
    expect(messageAuthor({ ts: nextTs(), user: 'U0STRANGER', text: 'x' }, identity)).toBe('other');
    expect(messageAuthor({ ts: nextTs(), user: 'U0OTHERBOT', bot_id: 'B0OTHER001', text: 'x' }, identity)).toBe('other');
    expect(messageAuthor({ ts: nextTs(), subtype: 'tombstone', text: 'x' }, identity)).toBe('other');
  });
});

describe('groupInteractions', () => {
  it('opens an interaction at each user message and gathers the bot messages after it', () => {
    const messages = [botRoot(), user('q1'), bot('a1'), bot('a1 more'), user('q2'), bot('a2'), user('q3')];

    const interactions = groupInteractions(messages, identity, { threadTs: THREAD });

    expect(interactions.map((i) => labels(interactionMessages(i)))).toEqual([['q1', 'a1', 'a1 more'], ['q2', 'a2'], ['q3']]);
  });

  it('puts bot messages before the first user message into a leading interaction without a user message', () => {
    const messages = [botRoot(), bot('handover replay 1'), bot('handover replay 2'), user('q1'), bot('a1')];

    const interactions = groupInteractions(messages, identity, { threadTs: THREAD });

    expect(interactions).toHaveLength(2);
    expect(interactions[0].user).toBeUndefined();
    expect(labels(interactions[0].bots)).toEqual(['handover replay 1', 'handover replay 2']);
  });

  it('never counts a bot-written root as an interaction, but a user-written root opens the first one', () => {
    const botRooted = groupInteractions([botRoot('header'), user('q1'), bot('a1')], identity, { threadTs: THREAD });
    expect(botRooted.map((i) => labels(interactionMessages(i)))).toEqual([['q1', 'a1']]);

    const userRooted = groupInteractions([userRoot('how?'), bot('a0'), user('q1'), bot('a1')], identity, { threadTs: THREAD });
    expect(userRooted.map((i) => labels(interactionMessages(i)))).toEqual([['how?', 'a0'], ['q1', 'a1']]);
  });

  it('leaves the summary message and messages of other authors out', () => {
    const summary = bot('📝 summary');
    const messages = [userRoot('how?'), summary, bot('a0'), { ts: nextTs(), user: 'U0STRANGER', thread_ts: THREAD, text: 'stranger' }, user('q1')];

    const interactions = groupInteractions(messages, identity, { threadTs: THREAD, summaryTs: summary.ts });

    expect(interactions.map((i) => labels(interactionMessages(i)))).toEqual([['how?', 'a0'], ['q1']]);
  });

  it('returns nothing for a thread that only has its root', () => {
    expect(groupInteractions([botRoot()], identity, { threadTs: THREAD })).toEqual([]);
  });
});

describe('selectInteractionsToPrune', () => {
  const interactions = (count: number) => groupInteractions(Array.from({ length: count }, (_, i) => user(`q${i + 1}`)), identity, { threadTs: THREAD });

  it('takes the oldest (count - keep) interactions and never the newest `keep`', () => {
    const all = interactions(12);

    const selected = selectInteractionsToPrune(all, { keep: 5, pruneAt: 10 });

    expect(selected).toHaveLength(7);
    expect(selected).toEqual(all.slice(0, 7));
    expect(selected.map((i) => i.user?.text)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7']);
  });

  it('does nothing while the thread is shorter than the prune threshold', () => {
    expect(selectInteractionsToPrune(interactions(9), { keep: 5, pruneAt: 10 })).toEqual([]);
    expect(selectInteractionsToPrune(interactions(10), { keep: 5, pruneAt: 10 })).toHaveLength(5);
  });

  it('with keep 0 and no threshold takes every interaction', () => {
    expect(selectInteractionsToPrune(interactions(3), { keep: 0 })).toHaveLength(3);
  });

  it('never selects more than exists', () => {
    expect(selectInteractionsToPrune(interactions(3), { keep: 5 })).toEqual([]);
  });
});

describe('planDeletions', () => {
  it('lists the messages of the selected interactions oldest first, tagged by author', () => {
    const interactions = groupInteractions([botRoot(), user('q1'), bot('a1'), user('q2'), bot('a2')], identity, { threadTs: THREAD });

    const plan = planDeletions(interactions.slice(0, 1), identity, { threadTs: THREAD });

    expect(plan.map((target) => [target.message.text, target.author])).toEqual([['q1', 'user'], ['a1', 'bot']]);
  });

  it('never includes the thread root or the message that becomes the summary', () => {
    const first = bot('a0');
    const interactions = groupInteractions([userRoot('how?'), first, bot('a0b')], identity, { threadTs: THREAD });

    const plan = planDeletions(interactions, identity, { threadTs: THREAD, keepTs: first.ts });

    expect(labels(plan.map((target) => target.message))).toEqual(['a0b']);
  });
});

describe('titles', () => {
  it('keeps a hand-written root title as it is', () => {
    expect(deriveTitle('[VLM_Verifier] MoT')).toBe('[VLM_Verifier] MoT');
    expect(deriveTitle('*[VLM_Verifier] MoT*')).toBe('[VLM_Verifier] MoT');
    expect(deriveTitle('**[VLM_Verifier] MoT**\n\n📝 지난 대화 요약\n- a')).toBe('[VLM_Verifier] MoT');
  });

  it('strips the emoji and markdown the bridge puts on a default root, and uses the first line only', () => {
    expect(deriveTitle('📁 **omp-slack-bridge** (main) · ~/.omp/agent/pi-slack-bridge\n새 세션')).toBe('omp-slack-bridge (main) · ~/.omp/agent/pi-slack-bridge');
    expect(deriveTitle(':file_folder: *project*')).toBe('project');
    expect(deriveTitle('🔄 Terminal session pushed to Slack')).toBe('Terminal session pushed to Slack');
    expect(deriveTitle('<https://example.com|Release notes> for Q&amp;A')).toBe('Release notes for Q&A');
  });

  it('falls back to a default when nothing is left, and limits the length', () => {
    expect(deriveTitle('')).toBe('세션');
    expect(deriveTitle(undefined)).toBe('세션');
    expect(deriveTitle('🔥')).toBe('세션');
    expect(normalizeTitle('x'.repeat(300))).toHaveLength(120);
    expect(normalizeTitle('  one \n two  ')).toBe('one two');
  });

  it('builds the header: bold title, blank line, summary heading and summary', () => {
    expect(buildThreadHeader('[VLM_Verifier] MoT', '- a\n- b')).toBe('**[VLM_Verifier] MoT**\n\n📝 지난 대화 요약\n- a\n- b');
    expect(buildThreadHeader('title only')).toBe('**title only**');
    expect(buildThreadHeader('**loud**', '  ')).toBe('**loud**');
  });
});

describe('the summary request', () => {
  it('transcribes an interaction, leaves `.bridge` commands out and flags attachments', () => {
    const [interaction] = groupInteractions([user('분석해줘'), bot('결과입니다', { files: [{ name: 'out.csv' }] })], identity, { threadTs: THREAD });
    expect(interactionTranscript(interaction)).toBe('사용자: 분석해줘\n\n에이전트: 결과입니다\n[첨부 파일: out.csv]');

    const [command] = groupInteractions([user('.bridge status'), bot('status text')], identity, { threadTs: THREAD });
    expect(interactionTranscript(command)).toBe('에이전트: status text');
    expect(interactionTranscript({ bots: [bot('  ')] })).toBe('');
  });

  it('keeps the whole text of a long message: what is deleted afterwards must have been read', () => {
    const long = `${'a'.repeat(1_500)}MIDDLE${'b'.repeat(3_000)}END`;

    const text = interactionTranscript({ bots: [bot(long)] });

    expect(text).toBe(`에이전트: ${long}`);
  });

  it('packs transcripts into rounds that stay within the limit', () => {
    const entries = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];

    const rounds = chunkTranscripts(entries, 100);

    expect(rounds).toHaveLength(2);
    expect(rounds.every((round) => round.length <= 100)).toBe(true);
    expect(rounds.join('')).toContain('b'.repeat(40));
    expect(chunkTranscripts([], 100)).toEqual([]);
  });

  it('spreads an entry that is longer than a round over several rounds without losing a line', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `줄-${String(i).padStart(4, '0')} ${'x'.repeat(30)}`);
    const entry = `에이전트: ${lines.join('\n')}`;

    const rounds = chunkTranscripts([entry], 1_000);

    expect(rounds.length).toBeGreaterThan(10);
    expect(rounds.every((round) => round.length <= 1_000)).toBe(true);
    const read = rounds.join('\n');
    for (const line of lines) expect(read, line).toContain(line);
    // Later pieces say that they continue an earlier one.
    expect(rounds[1].startsWith('…(앞에서 이어짐)\n')).toBe(true);
  });

  it('never cuts a character in two when it splits a long text without line breaks', () => {
    const entry = '😀'.repeat(3_000);

    const rounds = chunkTranscripts([entry], 999);

    expect(rounds.every((round) => round.length <= 999)).toBe(true);
    const read = rounds.map((round) => round.replace('…(앞에서 이어짐)\n', '')).join('');
    expect(read).toBe(entry);
    expect(read).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('compares Slack timestamps as numbers, with a bound that is a Slack ts of a moment', () => {
    expect(slackTsAtOrBefore('1760000001.000100', '1760000001.000100')).toBe(true);
    expect(slackTsAtOrBefore('1760000001.000099', '1760000001.000100')).toBe(true);
    expect(slackTsAtOrBefore('1760000001.000101', '1760000001.000100')).toBe(false);
    expect(slackTsAtOrBefore('1760000002.000000', '1760000001.999999')).toBe(false);
    expect(slackTsAtOrBefore('999999999.000001', '1760000001.000100')).toBe(true);
    // Not a timestamp: never selected.
    expect(slackTsAtOrBefore('later', '1760000001.000100')).toBe(false);
    expect(slackTsAtOrBefore('1760000001.000100', 'whenever')).toBe(false);
    expect(slackTsFromMs(1_760_000_001_250)).toBe('1760000001.250000');
    expect(slackTsFromMs(1_760_000_001_007)).toBe('1760000001.007000');
    expect(slackTsAtOrBefore('1760000001.249999', slackTsFromMs(1_760_000_001_250))).toBe(true);
    expect(slackTsAtOrBefore('1760000001.250001', slackTsFromMs(1_760_000_001_250))).toBe(false);
  });

  it('asks for a Korean bullet summary that merges the previous summary with the transcript', () => {
    const prompt = buildSummaryPrompt({ previousSummary: '- 이전 결정', transcript: '사용자: 다음 질문' });

    expect(prompt).toContain('<기존 요약>\n- 이전 결정\n</기존 요약>');
    expect(prompt).toContain('<새로 정리할 대화>\n사용자: 다음 질문\n</새로 정리할 대화>');
    expect(prompt).toContain('불릿');
    expect(prompt).toContain('도구를 쓰지 말고');
    expect(buildSummaryPrompt({ transcript: 't' })).toContain('<기존 요약>\n(없음)\n</기존 요약>');
  });

  it('tidies the model reply and refuses an empty one', () => {
    expect(normalizeSummary('\n- a\n- b\n')).toBe('- a\n- b');
    expect(normalizeSummary('```markdown\n- a\n```')).toBe('- a');
    expect(normalizeSummary('📝 지난 대화 요약\n- a')).toBe('- a');
    expect(normalizeSummary('- a\n\n\n\n- b')).toBe('- a\n\n- b');
    expect(() => normalizeSummary('   \n ')).toThrow('요약이 비어 있습니다');
  });

  it('cuts an overlong summary at a line boundary', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `- item ${i} ${'x'.repeat(20)}`).join('\n');

    const summary = normalizeSummary(lines);

    expect(summary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS + 4);
    expect(summary.endsWith('\n- …')).toBe(true);
    expect(summary.split('\n').slice(0, -1).every((line) => line.startsWith('- item'))).toBe(true);
  });
});
