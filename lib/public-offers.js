import Database from '@/lib/db/index.js'
import { listScheduledWebsitePromotions } from '@/lib/promotions.js'
import { comboAvailableOn, getCombosForMenuItems } from '@/lib/combos.js'
import { ensureWebsiteFeaturedSchema } from '@/lib/website-featured.js'
import { formatMenuPrice } from '@/lib/menu-format.js'
import { toPublicImageUrl } from '@/lib/public-image-url.js'
import { normalizeClockTime, promotionInstant } from '@/lib/promotion-display.js'

const DAY_LABELS = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' }

function headline(promo) {
  if (promo.offer_type === 'buy_x_get_y') {
    return Number(promo.reward_discount_percent) === 100
      ? `Buy ${promo.buy_quantity}, get ${promo.reward_quantity} free`
      : `Buy ${promo.buy_quantity}, get ${promo.reward_quantity} at ${promo.reward_discount_percent}% off`
  }
  if (promo.discount_type === 'percent') return `${promo.discount_value}% off`
  return `${formatMenuPrice(promo.discount_value)} off`
}

function kindFor(promo) {
  if (promo.offer_type === 'buy_x_get_y') return ['offer', 'Offer']
  if (promo.daily_start_time || promo.daily_end_time) return ['happy_hour', 'Happy hour']
  return ['discount', 'Discount']
}

function clock12(value) {
  const hhmm = normalizeClockTime(value)
  if (!hhmm) return null
  const [h, m] = hhmm.split(':').map(Number)
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`
}

function nepalDate(value) {
  const instant = promotionInstant(value, { endOfDay: true })
  if (!instant || Number.isNaN(instant.getTime())) return null
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', day: 'numeric', month: 'short', year: 'numeric' }).format(instant)
}

/** Short, customer-readable conditions: hours, days, what it covers, minimum, end date. */
function conditions(promo, targetNames) {
  const lines = []
  if (promo.daily_start_time || promo.daily_end_time) {
    lines.push(`${clock12(promo.daily_start_time) || 'Opening'} – ${clock12(promo.daily_end_time) || 'close'}`)
  }
  if (promo.days_of_week.length && promo.days_of_week.length < 7) {
    lines.push(promo.days_of_week.map((day) => DAY_LABELS[day] || day).join(', '))
  }
  if (promo.scope === 'order') lines.push('On your whole order')
  else if (targetNames.length) lines.push(`On ${targetNames.slice(0, 4).join(', ')}${targetNames.length > 4 ? ` +${targetNames.length - 4} more` : ''}`)
  if (promo.minimum_order_amount > 0) lines.push(`Orders over ${formatMenuPrice(promo.minimum_order_amount)}`)
  if (promo.maximum_discount_amount != null && promo.offer_type !== 'buy_x_get_y' && promo.discount_type === 'percent') {
    lines.push(`Save up to ${formatMenuPrice(promo.maximum_discount_amount)}`)
  }
  const ends = nepalDate(promo.ends_at)
  if (ends) lines.push(`Until ${ends}`)
  return lines
}

/**
 * Offers and combo packs the website may advertise right now. Uses the same
 * rules as checkout (website channel, schedule, usage limit) and as the menu
 * (combo active, on the website, every component available), so a card never
 * promises something the order form will refuse. Featured card comes first;
 * at most one is featured.
 */
export async function getPublicWebsiteOffers({ now = new Date() } = {}) {
  const db = Database.getInstance()
  await ensureWebsiteFeaturedSchema(db)

  const promotions = (await listScheduledWebsitePromotions(db, { forMarketing: true, now }))
    // Redeemable on the site: automatic, or a code the customer can type.
    .filter((promo) => (promo.auto_apply || promo.code) && (promo.scope === 'order' || promo.target_ids.length))
  const limited = promotions.filter((promo) => promo.usage_limit != null).map((promo) => promo.id)
  const used = new Map()
  if (limited.length) {
    const rows = await db.all(`SELECT pr.promotion_id, COUNT(*) AS uses FROM promotion_redemptions pr LEFT JOIN bills b ON b.id = pr.bill_id
      WHERE pr.promotion_id IN (${limited.map(() => '?').join(',')})
        AND (pr.bill_id IS NULL OR LOWER(COALESCE(b.status,'')) NOT IN ('void','voided','cancelled','canceled'))
      GROUP BY pr.promotion_id`, limited)
    for (const row of rows) used.set(Number(row.promotion_id), Number(row.uses))
  }

  const itemIds = promotions.filter((p) => p.scope === 'item').flatMap((p) => p.target_ids)
  const categoryIds = promotions.filter((p) => p.scope === 'category').flatMap((p) => p.target_ids)
  const names = async (table, ids) => (ids.length
    ? new Map((await db.all(`SELECT id, name FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`, ids)).map((r) => [Number(r.id), r.name]))
    : new Map())
  const [itemNames, categoryNames] = await Promise.all([names('menu_items', itemIds), names('menu_categories', categoryIds)])

  const promoCards = promotions
    .filter((promo) => promo.usage_limit == null || (used.get(promo.id) || 0) < promo.usage_limit)
    .map((promo) => {
      const [kind, kindLabel] = kindFor(promo)
      const lookup = promo.scope === 'item' ? itemNames : categoryNames
      const targetNames = promo.target_ids.map((id) => lookup.get(id)).filter(Boolean)
      return {
        key: `promo-${promo.id}`,
        kind,
        kindLabel,
        id: promo.id,
        name: promo.name,
        description: promo.description || '',
        image_url: toPublicImageUrl(promo.image_url) || null,
        badge: headline(promo),
        code: promo.code || null,
        automatic: promo.auto_apply,
        conditions: conditions(promo, targetNames),
        href: promo.code ? `/menu?coupon=${encodeURIComponent(promo.code)}` : '/menu',
        featured: promo.website_featured,
      }
    })

  const comboRows = await db.all(`
    SELECT mi.id, mi.name, mi.description, mi.image_url, mi.base_price AS price
      FROM menu_items mi JOIN menu_combos mc ON mc.menu_item_id = mi.id
     WHERE COALESCE(mi.is_available, 0) = 1
     ORDER BY mi.name`)
  const combos = await getCombosForMenuItems(db, comboRows.map((row) => row.id))
  const comboCards = comboRows
    .filter((row) => comboAvailableOn(combos.get(Number(row.id)), 'website'))
    .map((row) => {
      const combo = combos.get(Number(row.id))
      const price = Number(row.price || 0)
      const savings = Math.max(0, Math.round(combo.original_price - price))
      return {
        key: `combo-${row.id}`,
        kind: 'combo',
        kindLabel: 'Combo',
        id: Number(row.id),
        name: row.name,
        description: row.description || '',
        image_url: toPublicImageUrl(row.image_url) || null,
        badge: formatMenuPrice(price),
        price,
        originalPrice: savings > 0 ? combo.original_price : null,
        savings,
        components: combo.components.map((c) => `${c.quantity > 1 ? `${c.quantity}× ` : ''}${c.name}${c.variant_name ? ` (${c.variant_name})` : ''}`),
        code: null,
        conditions: [],
        href: '/menu?c=combos',
        featured: combo.website_featured,
      }
    })

  let seenFeatured = false
  return [...promoCards, ...comboCards]
    .sort((a, b) => Number(b.featured) - Number(a.featured))
    .map((card) => {
      if (!card.featured) return card
      if (seenFeatured) return { ...card, featured: false }
      seenFeatured = true
      return card
    })
}
