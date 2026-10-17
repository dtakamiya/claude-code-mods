import { test, expect } from 'claude-code/testing'
import { ARGUMENT_HINT, HELP_TEXT, parseCommandMode } from './copy'

test('引数なし・空白だけはペインを開く', () => {
  // Arrange / Act / Assert
  expect(parseCommandMode('')).toBe('open')
  expect(parseCommandMode('   ')).toBe('open')
})

test('copy / text / help は前後の空白と大文字小文字を無視する', () => {
  // Arrange / Act / Assert
  expect(parseCommandMode('copy')).toBe('copy')
  expect(parseCommandMode('  COPY ')).toBe('copy')
  expect(parseCommandMode('Text')).toBe('text')
  expect(parseCommandMode('\thelp\n')).toBe('help')
})

test('打ち間違い・知らない引数・複数の語は unknown', () => {
  // Arrange / Act / Assert
  expect(parseCommandMode('cpy')).toBe('unknown')
  expect(parseCommandMode('save')).toBe('unknown')
  expect(parseCommandMode('copy text')).toBe('unknown')
  expect(parseCommandMode('--help')).toBe('unknown')
  // Map 由来でないキー（プロトタイプ上の名前）を引数として受け付けない。
  expect(parseCommandMode('constructor')).toBe('unknown')
})

test('help の一覧と引数のヒントは、受け付ける引数をすべて載せる', () => {
  // Arrange
  const modes = ['copy', 'text', 'help']

  // Act / Assert
  for (const mode of modes) {
    expect(parseCommandMode(mode)).toBe(mode)
    expect(HELP_TEXT).toContain(`  ${mode} `)
    expect(ARGUMENT_HINT).toContain(mode)
  }
})
