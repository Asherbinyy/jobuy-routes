import rows from './seed-routes.json'
import type { Dataset } from '../domain/routes'

export const seed: Dataset = {
  id: 'original-workbook',
  name: 'Manchester Routing for peak 40 routes.xlsx',
  createdAt: '',
  rows: rows.map(row => ({
    route: String(row.route_number), postcode: row.postcode_original,
    sheet: row.source_sheet, row: row.source_row, originalRoute: String(row.route_number),
  })),
}
