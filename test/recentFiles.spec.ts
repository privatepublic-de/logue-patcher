import { describe, expect, it } from 'vitest'
import { withRecentFile } from '../src/main/config/recentFiles'

describe('withRecentFile', () => {
  it('puts a new file first', () => {
    expect(withRecentFile(['/a', '/b'], '/c')).toEqual(['/c', '/a', '/b'])
  })
  it('moves an existing file to the front without duplicating it', () => {
    expect(withRecentFile(['/a', '/b', '/c'], '/b')).toEqual(['/b', '/a', '/c'])
  })
  it('starts a list from nothing', () => {
    expect(withRecentFile(undefined, '/a')).toEqual(['/a'])
  })
  it('drops the oldest past the cap', () => {
    expect(withRecentFile(['/a', '/b', '/c'], '/d', 3)).toEqual(['/d', '/a', '/b'])
  })
})
