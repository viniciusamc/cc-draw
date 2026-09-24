type Props = {
  name: string
  monthly: number
  features: string[]
  highlight?: boolean
  yearly: boolean
}

export default function PlanCard({ name, monthly, features, highlight, yearly }: Props) {
  const price = yearly ? Math.round(monthly * 0.6) : monthly

  return (
    <article className={`plan${highlight ? ' plan--highlight' : ''}`}>
      {highlight && <span className="plan-badge">Most popular</span>}
      <h3>{name}</h3>
      <p className="price">
        {price === 0 ? 'Free' : <>${price}<small>/mo</small></>}
      </p>
      <ul>
        {features.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <button>{price === 0 ? 'Get started' : 'Subscribe'}</button>
    </article>
  )
}
