import Link from 'next/link';
import { UtensilsCrossed } from 'lucide-react';
import PageHead from '@/components/public/page-head';
import OfferCard from '@/components/public/offer-card';
import { getPublicWebsiteOffers } from '@/lib/public-offers';
import { getPublicContact } from '@/lib/public-content';

// Offers follow their schedule (happy hours, weekdays), so never cache the page.
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Offers & combos',
  description: 'Current discounts, happy hours, offer codes and combo packs.',
  alternates: { canonical: '/offers' },
};

export default async function OffersPage() {
  const [offers, contact] = await Promise.all([getPublicWebsiteOffers().catch(() => []), getPublicContact()]);
  const deals = offers.filter((offer) => offer.kind !== 'combo');
  const combos = offers.filter((offer) => offer.kind === 'combo');

  return (
    <>
      <PageHead title="Offers & combos" lead="Discounts, happy hours and combo packs running right now. Offers apply on your online order automatically, or with the code shown." />
      <div className="rc-wrap rc-section" style={{ paddingTop: 'clamp(2.5rem, 6vw, 4rem)' }}>
        {!offers.length ? (
          <div className="rc-empty">
            <UtensilsCrossed aria-hidden="true" style={{ width: '2rem', height: '2rem', color: 'var(--muted)', margin: '0 auto' }} />
            <h2 className="rc-h3" style={{ marginTop: '.75rem' }}>No offers running right now</h2>
            <p>Check back soon, or call <a href={contact.hrefs.tel} className="rc-link dsp-focus">{contact.phoneDisplay}</a> to ask about today&apos;s specials.</p>
            <Link href="/menu" className="rc-btn rc-btn--wall dsp-focus" style={{ marginTop: '1rem' }}>See the menu</Link>
          </div>
        ) : null}
        {deals.length ? (
          <section className="rc-offer-section" aria-labelledby="deals-title">
            <h2 id="deals-title" className="rc-h2">Deals</h2>
            <div className="rc-offer-grid">{deals.map((offer) => <OfferCard key={offer.key} offer={offer} />)}</div>
          </section>
        ) : null}
        {combos.length ? (
          <section className="rc-offer-section" aria-labelledby="combos-title">
            <h2 id="combos-title" className="rc-h2">Combo packs</h2>
            <div className="rc-offer-grid">{combos.map((offer) => <OfferCard key={offer.key} offer={offer} />)}</div>
          </section>
        ) : null}
      </div>
    </>
  );
}
