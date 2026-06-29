/**
 * Returns a SQL fragment that filters out soft-deleted rows.
 *
 * @param alias - optional table alias for JOIN queries (e.g. 'c' → "AND c.deleted_at IS NULL")
 */
export function softDeleteFilter(alias?: string): string {
  return alias ? `AND ${alias}.deleted_at IS NULL` : 'AND deleted_at IS NULL';
}