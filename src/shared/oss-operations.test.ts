import { describe, expect, it } from 'vitest'
import {
  buildFolderKey,
  buildRenameDestination,
  buildRenameObjectTarget,
  buildTransferPairs,
  normalizeObjectPrefix,
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
