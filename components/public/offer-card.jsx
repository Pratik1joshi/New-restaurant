'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, Copy } from 'lucide-react';
import { formatMenuPrice } from '@/lib/menu-format';

function CodeButton({ code }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* the code is still visible to type */ }
  };
  return (
    <button type="button" onClick={copy} className="rc-offer-code dsp-focus" aria-label={`Copy offer code ${code}`}>
      {code}{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      <span className="sr-only" aria-live="polite">{copied ? 'Copied' : ''}</span>
    </button>
  );
}

/** One offer or combo pack, as built by lib/public-offers.js. */
export default function OfferCard({ offer }) {
  const isCombo = offer.kind === 'combo';
  return (
    <article className={`rc-offer${offer.featured ? ' rc-offer--featured' : ''}`}>
      <div className="rc-offer-media">
        {offer.image_url
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={offer.image_url} alt="" loading="lazy" />
          : <span className="rc-offer-big">{isCombo ? (offer.savings > 0 ? `Save ${formatMenuPrice(offer.savings)}` : formatMenuPrice(offer.price)) : offer.badge}</span>}
        <span className="rc-offer-tags">
          <span className="rc-offer-tag">{offer.kindLabel}</span>
          {offer.featured ? <span className="rc-offer-tag rc-offer-tag--gold">Featured</span> : null}
        </span>
      </div>
      <div className="rc-offer-body">
        <h3 className="rc-h3">{offer.name}</h3>
        {isCombo ? (
          <div className="rc-offer-price">
            <strong>{formatMenuPrice(offer.price)}</strong>
            {offer.originalPrice ? <s>{formatMenuPrice(offer.originalPrice)}</s> : null}
            {offer.savings > 0 ? <span>Save {formatMenuPrice(offer.savings)}</span> : null}
          </div>
        ) : offer.image_url ? (
          <p className="rc-offer-headline">{offer.badge}</p>
        ) : null}
        {offer.description ? <p>{offer.description}</p> : null}
        {isCombo && offer.components?.length ? <p>{offer.components.join(' · ')}</p> : null}
        {offer.conditions?.length ? (
          <ul className="rc-offer-terms">{offer.conditions.map((line) => <li key={line}>{line}</li>)}</ul>
        ) : null}
        <div className="rc-offer-foot">
          {offer.code ? <CodeButton code={offer.code} /> : !isCombo && offer.automatic ? <span className="rc-offer-auto">Applied automatically</span> : <span />}
          <Link href={offer.href} className="rc-link dsp-focus">{offer.code ? 'Order with code' : isCombo ? 'Order combo' : 'Order now'}</Link>
        </div>
      </div>
    </article>
  );
}
