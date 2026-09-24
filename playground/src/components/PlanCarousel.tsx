import { useEffect, useRef, useState, type CSSProperties } from 'react'
import PlanCard from './PlanCard'

type Plan = { name: string; monthly: number; features: string[]; highlight?: boolean }

// Precisa bater com a duração da transição do .carousel__track no CSS.
const SLIDE_MS = 600
const AUTOPLAY_MS = 4500

export default function PlanCarousel({ plans, yearly }: { plans: Plan[]; yearly: boolean }) {
  const n = plans.length
  // Três cópias: a do meio é a "real"; as das pontas deixam o loop contínuo.
  const slides = [...plans, ...plans, ...plans]
  const [pos, setPos] = useState(() => n + Math.max(0, plans.findIndex((p) => p.highlight)))
  const [instant, setInstant] = useState(false)
  const [paused, setPaused] = useState(false)
  const [reducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const moving = useRef(false)
  const dragStart = useRef<number | null>(null)
  const active = ((pos % n) + n) % n

  const go = (target: number) => {
    if (moving.current || target === pos) return
    moving.current = true
    setInstant(false)
    setPos(target)
  }

  // Depois de cada deslize, se saímos da cópia do meio, volta pra ela sem animação.
  useEffect(() => {
    if (instant) {
      let inner = 0
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setInstant(false))
      })
      return () => {
        cancelAnimationFrame(outer)
        cancelAnimationFrame(inner)
      }
    }
    const t = setTimeout(() => {
      moving.current = false
      if (pos < n || pos >= 2 * n) {
        setInstant(true)
        setPos(n + (((pos % n) + n) % n))
      }
    }, SLIDE_MS)
    return () => clearTimeout(t)
  }, [pos, instant, n])

  useEffect(() => {
    if (paused || reducedMotion || instant) return
    const t = setTimeout(() => go(pos + 1), AUTOPLAY_MS)
    return () => clearTimeout(t)
  })

  return (
    <section
      className="carousel"
      aria-roledescription="carousel"
      aria-label="Plans"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') go(pos - 1)
        if (e.key === 'ArrowRight') go(pos + 1)
      }}
    >
      <div
        className="carousel__viewport"
        onPointerDown={(e) => (dragStart.current = e.clientX)}
        onPointerUp={(e) => {
          if (dragStart.current === null) return
          const delta = e.clientX - dragStart.current
          if (Math.abs(delta) > 40) go(pos + (delta < 0 ? 1 : -1))
          dragStart.current = null
        }}
      >
        <div
          className={`carousel__track${instant ? ' carousel__track--instant' : ''}`}
          style={{ '--pos': pos } as CSSProperties}
        >
          {slides.map((plan, i) => (
            <div
              key={`${plan.name}-${i}`}
              className={`carousel__slide${i === pos ? ' carousel__slide--active' : ''}`}
              aria-hidden={i < n || i >= 2 * n}
              onClick={() => go(i)}
            >
              <PlanCard {...plan} yearly={yearly} />
            </div>
          ))}
        </div>
      </div>

      <div className="carousel__controls">
        <button className="carousel__arrow" onClick={() => go(pos - 1)} aria-label="Previous plan">
          ‹
        </button>
        <div className="carousel__dots">
          {plans.map((plan, i) => (
            <button
              key={plan.name}
              className="carousel__dot"
              aria-label={`Show ${plan.name}`}
              aria-current={i === active}
              onClick={() => go(pos - active + i)}
            />
          ))}
        </div>
        <button className="carousel__arrow" onClick={() => go(pos + 1)} aria-label="Next plan">
          ›
        </button>
      </div>
    </section>
  )
}
