import { describe, expect, it } from 'vitest'
import {
  assertSavableTextContent,
  buildFolderKey,
  buildRenameDestination,
  buildRenameObjectTarget,
  buildTransferPairs,
  classifyObjectPreview,
  detectLineEnding,
  isTextEditable,
  normalizeLineEnding,
  normalizeObjectPrefix,
  utf8ByteLength,
  validateObjectEntryName
} from './oss-operations'

describe('normalizeObjectPrefix', () => {
  it('normalizes root and nested prefixes', () => {
    expect(normalizeObjectPrefix('')).toBe('')
    expect(normalizeObjectPrefix(' /releases/windows// ')).toBe('releases/windows')
  })
})

describe('validateObjectEntryName', () => {
  it('trims valid names', () => {
    expect(validateObjectEntryName(' release-2025 ')).toBe('release-2025')
    expect(validateObjectEntryName('archive.zip')).toBe('archive.zip')
  })

  it.each(['', '   ', '.', '..', 'child/name', 'child\\name'])('rejects invalid name %j', (name) => {
    expect(() => validateObjectEntryName(name)).toThrow()
  })
})

describe('buildFolderKey', () => {
  it('creates root and nested directory marker keys', () => {
    expect(buildFolderKey('', 'release')).toBe('release/')
    expect(buildFolderKey('/apps/windows/', 'release')).toBe('apps/windows/release/')
  })
})

describe('rename path calculation', () => {
  it('renames root and nested files without changing the parent', () => {
    expect(buildRenameDestination('README.md', 'README.txt')).toBe('README.txt')
    expect(buildRenameDestination('apps/windows/setup.exe', 'client.exe')).toBe('apps/windows/client.exe')
  })

  it('renames folder keys and keeps the marker slash', () => {
    expect(buildRenameDestination('release/', 'archive')).toBe('archive/')
    expect(buildRenameDestination('apps/release/', 'archive')).toBe('apps/archive/')
  })

  it('rejects an unchanged name', () => {
    expect(() => buildRenameDestination('apps/release/', 'release')).toThrow('新名称与原名称相同')
  })

  it('maps directory markers and descendants to the renamed folder', () => {
    const source = 'apps/release/'
    const destination = 'apps/archive/'
    expect(buildRenameObjectTarget(source, destination, source)).toBe(destination)
    expect(buildRenameObjectTarget(source, destination, 'apps/release/setup.exe')).toBe('apps/archive/setup.exe')
    expect(buildRenameObjectTarget(source, destination, 'apps/release/x64/setup.exe')).toBe('apps/archive/x64/setup.exe')
  })

  it('rejects objects outside the renamed folder', () => {
    expect(() => buildRenameObjectTarget('apps/release/', 'apps/archive/', 'apps/other/file.txt')).toThrow()
  })
})

describe('transfer path calculation', () => {
  it('moves files to root or nested destinations', () => {
    expect(buildTransferPairs('apps/file.txt', ['apps/file.txt'], '')).toEqual([{ source: 'apps/file.txt', target: 'file.txt' }])
    expect(buildTransferPairs('apps/file.txt', ['apps/file.txt'], '/archive/')).toEqual([{ source: 'apps/file.txt', target: 'archive/file.txt' }])
  })

  it('maps a folder marker and all descendants', () => {
    expect(buildTransferPairs('apps/release/', [
      'apps/release/',
      'apps/release/setup.exe',
      'apps/release/x64/setup.exe'
    ], 'archive')).toEqual([
      { source: 'apps/release/', target: 'archive/release/' },
      { source: 'apps/release/setup.exe', target: 'archive/release/setup.exe' },
      { source: 'apps/release/x64/setup.exe', target: 'archive/release/x64/setup.exe' }
    ])
  })

  it('rejects the same parent and descendant destinations', () => {
    expect(() => buildTransferPairs('apps/release/', ['apps/release/a.txt'], 'apps')).toThrow('目标位置与原位置相同')
    expect(() => buildTransferPairs('apps/release/', ['apps/release/a.txt'], 'apps/release')).toThrow('自身内部')
    expect(() => buildTransferPairs('apps/release/', ['apps/release/a.txt'], 'apps/release/child')).toThrow('自身内部')
  })

  it('rejects objects outside the selected folder', () => {
    expect(() => buildTransferPairs('apps/release/', ['apps/other/a.txt'], 'archive')).toThrow()
  })
})


describe('classifyObjectPreview', () => {
  it('classifies text and image extensions', () => {
    expect(classifyObjectPreview('readme.md')).toBe('text')
    expect(classifyObjectPreview('logs/app.LOG')).toBe('text')
    expect(classifyObjectPreview('config/db.json')).toBe('text')
    expect(classifyObjectPreview('pic/icon.png')).toBe('image')
    expect(classifyObjectPreview('archive.zip')).toBeNull()
  })
})

describe('isTextEditable', () => {
  it('allows text files within the 500 KB limit', () => {
    expect(isTextEditable('notes.txt', 0)).toBe(true)
    expect(isTextEditable('a/b/c.json', 500 * 1024)).toBe(true)
    expect(isTextEditable('deep/log.log', 1024)).toBe(true)
  })

  it('rejects text over the limit', () => {
    expect(isTextEditable('big.txt', 500 * 1024 + 1)).toBe(false)
  })

  it('rejects images and unsupported types regardless of size', () => {
    expect(isTextEditable('photo.png', 1024)).toBe(false)
    expect(isTextEditable('archive.zip', 1024)).toBe(false)
  })

  it('rejects when size is unknown', () => {
    expect(isTextEditable('notes.txt')).toBe(false)
    expect(isTextEditable('notes.txt', Number.NaN)).toBe(false)
  })
})

describe('utf8ByteLength', () => {
  it('counts ascii and multibyte characters by UTF-8 bytes', () => {
    expect(utf8ByteLength('abc')).toBe(3)
    expect(utf8ByteLength('中')).toBe(3)
    expect(utf8ByteLength('中文abc')).toBe(9)
  })

  it('counts astral characters as 4 bytes', () => {
    expect(utf8ByteLength('\u{1F600}')).toBe(4)
  })
})

describe('assertSavableTextContent', () => {
  it('accepts content within the limit', () => {
    expect(() => assertSavableTextContent('hello')).not.toThrow()
    expect(() => assertSavableTextContent('中'.repeat(1000))).not.toThrow()
  })

  it('rejects content over 500 KB even when the character count is small', () => {
    expect(() => assertSavableTextContent('中'.repeat(200 * 1024))).toThrow(/500 KB/)
  })

  it('rejects binary content containing NUL', () => {
    expect(() => assertSavableTextContent('a\u0000b')).toThrow(/二进制/)
  })
})

describe('line ending handling', () => {
  it('detects CRLF only when present', () => {
    expect(detectLineEnding('a\r\nb')).toBe('\r\n')
    expect(detectLineEnding('a\nb')).toBe('\n')
    expect(detectLineEnding('plain')).toBe('\n')
  })

  it('normalizes mixed endings to the target style', () => {
    expect(normalizeLineEnding('a\r\nb\nc', '\r\n')).toBe('a\r\nb\r\nc')
    expect(normalizeLineEnding('a\r\nb\r\n', '\n')).toBe('a\nb\n')
  })

  it('is idempotent and keeps a CRLF file from being rewritten with LF', () => {
    const crlf = 'line1\r\nline2\r\n'
    expect(normalizeLineEnding(crlf, detectLineEnding(crlf))).toBe(crlf)
  })
})
