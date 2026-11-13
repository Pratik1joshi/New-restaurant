/**
 * Shared offer badge helpers for POS + website menu grids.
 * Schedule checks are safe for client + server (Nepal time).
 */

export function promotionMenuBadgeLabel(promo) {
  if (!promo) return null
  if (promo.offer_type === 'buy_x_get_y') {
    return `Buy ${promo.buy_quantity} get ${promo.reward_quantity}`
  }
  if (promo.discount_type === 'percent') return `${promo.discount_value}% off`
  return `Rs ${promo.discount_value} off`
}

/** First matching auto offer for a menu product (order → item → category). */
export function findPromotionForProduct(promotions, product) {
  const menuId = Number(product?.id || product?.menu_item_id || product?.item_id || 0)
  const categoryId = Number(product?.category_id || 0)
  for (const promo of promotions || []) {
    const scope = promo.scope || 'order'
    const targets = (promo.target_ids || []).map(Number)
    if (scope === 'order') return promo
    if (scope === 'item' && targets.includes(menuId)) return promo
    if (scope === 'category' && targets.includes(categoryId)) return promo
  }
  return null
}

/** Combos first, then name. */
export function sortCombosFirst(items, isComboFn = (item) => Boolean(item?.is_combo || item?.isCombo || item?.combo)) {
  return [...(items || [])].sort((a, b) => {
    const comboDelta = Number(isComboFn(b)) - Number(isComboFn(a))
    if (comboDelta) return comboDelta
    return String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { sensitivity: 'base' })
  })
}

/** Normalize "7:00", "07:00:00", "12:00 PM" → "HH:MM" (24h). */
export function normalizeClockTime(value) {
  if (value == null || value === '') return null
  const raw = String(value).trim()
  const ampm = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i)
  if (!ampm) return null
  let hour = Number(ampm[1])
  const minute = ampm[2]
  const meridiem = (ampm[3] || '').toLowerCase()
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null
  return `${String(hour).padStart(2, '0')}:${minute}`
}

export function nepalClockNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kathmandu',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  let hour = parts.find((part) => part.type === 'hour')?.value || '00'
  const minute = parts.find((part) => part.type === 'minute')?.value || '00'
  if (hour === '24') hour = '00'
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
}

/**
 * True when the offer is inside its date range, weekday list, and daily window.
 * Daily end is exclusive ("until 12:00" ends at 12:00 sharp).
 */
/**
 * Offer start/end as an instant. Admin saves Nepal wall-clock text without a
 * zone ("2026-11-10T18:00"); `new Date()` would read that in the server's zone.
 * A date-only end means the whole day.
 */
export function promotionInstant(value, { endOfDay = false } = {}) {
  if (value == null || value === '') return null
  if (value instanceof Date) return value
  const raw = String(value).trim().replace(' ', 'T')
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) return new Date(raw)
  const [date, time] = raw.split('T')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Date(raw)
  const clock = time ? `${time.slice(0, 5)}:${time.slice(6, 8) || '00'}` : (endOfDay ? '23:59:59' : '00:00:00')
  return new Date(`${date}T${clock}+05:45`)
}

/** Nepal wall-clock "YYYY-MM-DDTHH:MM" for a datetime form field. */
export function toNepalFormDateTime(value) {
  const instant = promotionInstant(value)
  if (!instant || Number.isNaN(instant.getTime())) return ''
  const shifted = new Date(instant.getTime() + 345 * 60000)
  return shifted.toISOString().slice(0, 16)
}

export function isPromotionScheduledNow(promotion, now = new Date()) {
  if (!promotion) return false
  const starts = promotionInstant(promotion.starts_at)
  const ends = promotionInstant(promotion.ends_at, { endOfDay: true })
  if (starts && now < starts) return false
  if (ends && now > ends) return false
  const days = promotion.days_of_week || []
  if (days.length) {
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kathmandu',
      weekday: 'short',
    })
      .format(now)
      .toLowerCase()
    if (!days.includes(weekday)) return false
  }
  if (promotion.daily_start_time || promotion.daily_end_time) {
    const current = nepalClockNow(now)
    const start = normalizeClockTime(promotion.daily_start_time) || '00:00'
    const end = normalizeClockTime(promotion.daily_end_time) || '23:59'
    // Exclusive end so "ends 12:00" is off at noon, not for the whole 12:00 minute.
    const inWindow =
      start <= end ? current >= start && current < end : current >= start || current < end
    if (!inWindow) return false
  }
  return true
}
