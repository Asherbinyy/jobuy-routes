import { utils, write } from 'xlsx'

export function fixtureRows(count: number) {
  const rows: (number | string)[][] = [
    ['Metadata', 'Postcode sector', 'Route identifier'],
    ['core', 'M1 3', count === 12 ? 'R2' : 'R3'],
    ['extra', count === 12 ? 'M1 4' : 'M1 7', 'R3'],
    ['verified', 'M1 6HQ', 'R1'],
    ['other district', 'M10 1', 'R1'],
  ]
  for (let index = 1; index <= count; index++) {
    rows.push(['route', `WN${1 + Math.floor((index - 1) / 10)} ${(index - 1) % 10}`, `R${index}`])
  }
  return rows
}

export function workbookBytes(entries: Record<string, (string | number | Date)[][]>, bookType: 'xlsx' | 'biff8' = 'xlsx') {
  const book = utils.book_new()
  for (const [name, rows] of Object.entries(entries)) utils.book_append_sheet(book, utils.aoa_to_sheet(rows), name)
  return write(book, { type: 'buffer', bookType }) as Buffer
}

export const csvBuffer = (rows: (string | number)[][]) => Buffer.from(rows.map(row =>
  row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\n'))
