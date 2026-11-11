import { test, expect } from 'claude-code/testing'

import {
  COACH_OFF_TEXT,
  COACH_ON_TEXT,
  COACH_USAGE_TEXT,
  GLOBAL_WINDOW,
  INITIAL_STATE,
  NOTICE_PREFIX,
  RULE_MESSAGES,
  handleCoachCommand,
  isApprovalOnly,
  isPasted,
  judgeSubmission,
  setStopped,
  type CoachState,
  type PromptSignal,
  type RuleId,
} from './analyze'

// 架空データのみ。
const typed = (text: string, overrides: Partial<PromptSignal> = {}): PromptSignal => ({
  text,
  originKind: 'composer',
  isMeta: false,
  isCommand: false,
  ...overrides,
})

// 1 通ずつ送ったときの通知を、送信順に返す（null は出さなかった）。
const noticesOf = (texts: readonly string[], start: CoachState = INITIAL_STATE): (string | null)[] => {
  let state = start
  return texts.map(text => {
    const judgement = judgeSubmission(state, typed(text))
    state = judgement.state
    return judgement.notice
  })
}

const noticeFor = (id: RuleId): string => `${NOTICE_PREFIX}${RULE_MESSAGES[id]}`
const fill = (text: string, count: number): string[] => Array.from({ length: count }, () => text)

test('初回の「これ直して」は対象不足として指南する', () => {
  // Arrange
  const texts = ['これ直して']

  // Act
  const notices = noticesOf(texts)

  // Assert
  expect(notices[0]).toBe(noticeFor('vague-target'))
})

test('2 通目以降の同じ指示語だけの文では vague-target は出ない', () => {
  // Arrange
  const texts = ['はい', 'これ直して']

  // Act
  const notices = noticesOf(texts)

  // Assert
  expect(notices).toEqual([null, null])
})

test('指示語があってもファイルパス・拡張子があれば vague-target は出ない', () => {
  expect(noticesOf(['これ src/app.ts 直して'])).toEqual([null])
})

test('指示語があってもコード識別子らしき英語語があれば vague-target は出ない', () => {
  expect(noticesOf(['これ fooBar 直して'])).toEqual([null])
})

test('指示語があってもエラー文らしき語があれば vague-target は出ない', () => {
  expect(noticesOf(['これエラーが出る'])).toEqual([null])
})

test('指示語があってもバッククォートのコードがあれば vague-target は出ない', () => {
  expect(noticesOf(['これ `parse()` 直して'])).toEqual([null])
})

test('広い動詞だけの短い依頼は範囲不足として指南する', () => {
  expect(noticesOf(['リファクタして'])).toEqual([noticeFor('no-scope')])
})

test('40 字以上の広い依頼は no-scope で出ない', () => {
  // Arrange
  const longText = `リファクタを${'あ'.repeat(40)}して`

  // Act
  const notices = noticesOf([longText])

  // Assert
  expect(notices).toEqual([null])
})

test('パス等があれば no-scope は出ない', () => {
  expect(noticesOf(['src/a.ts をリファクタして'])).toEqual([null])
})

test('読点で 4 つ以上に分かれると 1 通 1 ゴールの指南を出す', () => {
  expect(noticesOf(['認証を追加して、テストも、READMEも、あとCI'])).toEqual([noticeFor('multi-task')])
})

test('読点で 3 つ以下なら multi-task は出ない', () => {
  expect(noticesOf(['AとB、Cを直して'])).toEqual([null])
})

test('コードを含む文は multi-task の区切りに数えない', () => {
  expect(noticesOf(['`a`、`b`、`c`、`d`を直して'])).toEqual([null])
})

test('行頭の箇条記号は区切りとして数え、文中の中黒では割らない', () => {
  // 中黒 2 つで区切ると 3 断片のまま（4 つ未満）。
  expect(noticesOf(['認証・テスト・CI・READMEを直して'])).toEqual([null])
  // 行頭の箇条記号で 4 行に分かれると多段と判定する。
  expect(noticesOf(['- 認証を直す\n- テストを書く\n- CIを直す\n- READMEを書く'])).toEqual([noticeFor('multi-task')])
})

test('読点が 4 つ以上ある 1 ゴールの文も多段として出る（既知の誤検知）', () => {
  // 仕様どおり読点の数だけで判定するため、1 ゴールでも出る。報告の既知事項。
  const oneGoal = 'src/auth.tsのlogin関数を、既存テストが通る状態のまま、引数の型だけ直して、戻り値は変えないで'

  expect(noticesOf([oneGoal])).toEqual([noticeFor('multi-task')])
})

test('実装語があって完了条件語が無い短い依頼は完了の判定を指南する', () => {
  expect(noticesOf(['認証を追加して'])).toEqual([noticeFor('no-done-criterion')])
})

test('完了条件語（テスト・通る・ように）があれば no-done-criterion は出ない', () => {
  expect(noticesOf(['テストが通るように認証を追加して'])).toEqual([null])
})

test('30 字以上の実装依頼は no-done-criterion で出ない', () => {
  // Arrange
  const longText = `認証を追加する${'あ'.repeat(30)}`

  // Act
  const notices = noticesOf([longText])

  // Assert
  expect(notices).toEqual([null])
})

test('複数ルールに当たるときは優先順位の高いものを 1 行だけ出す', () => {
  // Arrange: vague-target・no-scope・multi-task に当たる文（英数字の識別子を含めない）。
  const text = 'これ、リファクタして、テストも、あと確認も'

  // Act
  const notice = noticesOf([text])[0]

  // Assert
  expect(notice).toBe(noticeFor('vague-target'))
  expect(notice?.includes('\n')).toBe(false)
})

test('スラッシュコマンド（command あり）は黙り、通数も数えない', () => {
  // Act
  const judgement = judgeSubmission(INITIAL_STATE, typed('これ直して', { isCommand: true }))

  // Assert
  expect(judgement.notice).toBeNull()
  expect(judgement.state.humanCount).toBe(0)
})

test('text が / で始まる送信は黙る', () => {
  expect(noticesOf(['/coach off', '/リファクタして'])).toEqual([null, null])
})

test('isMeta の送信は黙る', () => {
  const judgement = judgeSubmission(INITIAL_STATE, typed('リファクタして', { isMeta: true }))

  expect(judgement.notice).toBeNull()
})

test('人の Enter 以外の起源（通知・ピア・定期実行など）は黙る', () => {
  const origins = ['task-notification', 'peer', 'scheduled-trigger', 'plugin']

  const notices = origins.map(originKind => judgeSubmission(INITIAL_STATE, typed('リファクタして', { originKind })).notice)

  expect(notices).toEqual([null, null, null, null])
})

test('bridge（Remote Control 経由）は端末の status 行で見えないため黙る', () => {
  const judgement = judgeSubmission(INITIAL_STATE, typed('リファクタして', { originKind: 'bridge' }))

  expect(judgement.notice).toBeNull()
})

test('承認・継続だけの短い送信は黙る', () => {
  const texts = ['はい', 'OK!', '続けて', 'はい、お願いします', '進めてください']

  const notices = noticesOf(texts)

  expect(notices).toEqual(texts.map(() => null))
})

test('承認語でない短い依頼は承認として扱わない', () => {
  expect(isApprovalOnly('認証を追加して')).toBe(false)
  expect(isApprovalOnly('はい、認証を追加して')).toBe(false)
  expect(isApprovalOnly('')).toBe(false)
})

test('コードフェンスを含む送信は貼り付けとして黙る', () => {
  expect(isPasted('```ts\nconst a = 1\n```')).toBe(true)
  expect(noticesOf(['```\nリファクタして\n```'])).toEqual([null])
})

test('5 行以上かつ 300 字超の送信は貼り付けとして黙る', () => {
  // Arrange
  const pasted = `${'ログ行\n'.repeat(4)}${'あ'.repeat(301)}`

  // Act & Assert
  expect(isPasted(pasted)).toBe(true)
})

test('5 行あっても 300 字以下の送信は貼り付けとみなさない', () => {
  // Arrange
  const short = `${'a\n'.repeat(4)}b`

  // Act & Assert
  expect(isPasted(short)).toBe(false)
  expect(isPasted('リファクタして')).toBe(false)
})

test('コーチ停止中は指南を出さないが、通数は数える', () => {
  // Arrange
  const stopped = setStopped(INITIAL_STATE, true)

  // Act
  const judgement = judgeSubmission(stopped, typed('リファクタして'))

  // Assert
  expect(judgement.notice).toBeNull()
  expect(judgement.state.humanCount).toBe(1)
})

test('同じルールは 1 セッションに 2 回まで（直近の窓を空けても 3 回目は出ない）', () => {
  // Arrange: 1 通目と GLOBAL_WINDOW 通後に出し、その後の 3 回目は上限で止まる。
  const texts = [
    'リファクタして',
    ...fill('はい', GLOBAL_WINDOW - 1),
    'リファクタして',
    ...fill('はい', GLOBAL_WINDOW - 1),
    'リファクタして',
  ]

  // Act
  const notices = noticesOf(texts)

  // Assert
  expect(notices[0]).toBe(noticeFor('no-scope'))
  expect(notices[GLOBAL_WINDOW]).toBe(noticeFor('no-scope'))
  expect(notices[texts.length - 1]).toBeNull()
})

test('直近 10 通以内では全体で 2 回目を出さない', () => {
  // Arrange: 別ルールの文でも窓の中では出ない。
  const texts = ['リファクタして', 'はい', '認証を追加して']

  // Act
  const notices = noticesOf(texts)

  // Assert
  expect(notices).toEqual([noticeFor('no-scope'), null, null])
})

test('上限に達したルールは次の優先ルールに譲る', () => {
  // Arrange: no-scope と no-done-criterion の両方に当たる文を、no-scope の上限後に送る。
  const both = 'リファクタして追加して'
  const texts = [
    'リファクタして',
    ...fill('はい', GLOBAL_WINDOW - 1),
    'リファクタして',
    ...fill('はい', GLOBAL_WINDOW - 1),
    both,
  ]

  // Act
  const notices = noticesOf(texts)

  // Assert
  expect(notices[texts.length - 1]).toBe(noticeFor('no-done-criterion'))
})

test('初期状態からは同じ 1 通目の指南が再び出る（セッション開始時に相当）', () => {
  // Arrange: 1 通目で vague-target を出した状態を作る。
  const afterFirst = judgeSubmission(INITIAL_STATE, typed('これ直して')).state

  // Act
  const fresh = judgeSubmission(INITIAL_STATE, typed('これ直して'))

  // Assert
  expect(afterFirst.lastShownAt).toBe(1)
  expect(fresh.notice).toBe(noticeFor('vague-target'))
})

test('判定は元の状態を変えず、新しい状態を返す', () => {
  // Arrange
  const shown = judgeSubmission(INITIAL_STATE, typed('リファクタして')).state
  const snapshot = JSON.stringify(shown)

  // Act
  const judgement = judgeSubmission(shown, typed('リファクタして'))

  // Assert
  expect(JSON.stringify(shown)).toBe(snapshot)
  expect(judgement.state).not.toBe(shown)
  expect(Object.isFrozen(INITIAL_STATE)).toBe(true)
})

test('通知文は先頭が 💡 で、全角 60 字以内、入力の本文を含まない', () => {
  // Arrange
  const ids = Object.keys(RULE_MESSAGES) as RuleId[]

  // Act & Assert
  for (const id of ids) {
    expect(noticeFor(id).startsWith('💡 ')).toBe(true)
    expect([...noticeFor(id)].length).toBeLessThanOrEqual(60)
  }
  const notice = noticesOf(['認証を追加して'])[0]
  expect(notice).not.toContain('認証')
})

test('/coach off で停止し、on で再開する。不明な引数は状態を変えない', () => {
  // Act
  const off = handleCoachCommand(INITIAL_STATE, 'off')
  const on = handleCoachCommand(off.state, ' ON ')
  const unknown = handleCoachCommand(on.state, 'maybe')

  // Assert
  expect(off).toEqual({ state: { ...INITIAL_STATE, isStopped: true }, text: COACH_OFF_TEXT })
  expect(on).toEqual({ state: { ...INITIAL_STATE, isStopped: false }, text: COACH_ON_TEXT })
  expect(unknown.state).toBe(on.state)
  expect(unknown.text).toBe(COACH_USAGE_TEXT)
})
