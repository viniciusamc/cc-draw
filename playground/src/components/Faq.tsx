import { useState } from 'react'

const FAQ = [
  ['How do I make my first deploy?', 'Connect your GitHub repository or drag the site folder into the dashboard. In under a minute it is live, with HTTPS.'],
  ['Can I use my own domain?', 'Yes, from the Pro plan up. Point your DNS to us and the SSL certificate is issued and renewed automatically.'],
  ['What if I go over my plan limit?', 'Your site stays up. We let you know by email and you decide whether to upgrade.'],
  ['Is there a free trial?', 'The Pro plan has a 14-day free trial, no card required. If you don’t like it, it goes back to Hobby on its own.'],
  ['Can I cancel anytime?', 'Yes. Cancel from the dashboard, no fees, and you won’t pay anything the following month.'],
]

export default function Faq() {
  const [open, setOpen] = useState<number | null>(0)

  return (
    <section className="faq">
      <h2>Frequently asked questions</h2>
      <p className="faq__intro">Everything you need to know before you ship.</p>
      <div className="faq__list">
        {FAQ.map(([q, a], i) => {
          const isOpen = open === i
          return (
            <div key={q} className={`faq__item${isOpen ? ' faq__item--open' : ''}`}>
              <button
                className="faq__question"
                aria-expanded={isOpen}
                aria-controls={`faq-${i}`}
                onClick={() => setOpen(isOpen ? null : i)}
              >
                {q}
                <span className="faq__icon" aria-hidden="true" />
              </button>
              <div id={`faq-${i}`} className="faq__answer" role="region">
                <div>
                  <p>{a}</p>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
