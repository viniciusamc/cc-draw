import { useState } from 'react'
import Header from './components/Header'
import PlanCarousel from './components/PlanCarousel'
import Backdrop from './components/Backdrop'
import Faq from './components/Faq'
import './App.css'

const PLANS = [
  { name: 'Hobby', monthly: 0, features: ['1 project', '1 GB of storage', 'Community support'] },
  { name: 'Pro', monthly: 29, features: ['Unlimited projects', '100 GB of storage', 'Custom domain', 'Email support'], highlight: true },
  { name: 'Team', monthly: 79, features: ['Everything in Pro', 'Up to 20 people', 'SSO', 'Priority support'] },
]

function App() {
  const [yearly, setYearly] = useState(false)

  return (
    <>
      <Backdrop />
      <Header />

      <section className="hero">
        <span className="hero__eyebrow">🎉 40% off the yearly plan</span>
        <h1>Ship AI models <span className="hero__accent">before your coffee gets cold.</span></h1>
        <div className="billing">
          <button className={!yearly ? 'active' : ''} onClick={() => setYearly(false)}>Monthly</button>
          <button className={yearly ? 'active' : ''} onClick={() => setYearly(true)}>Yearly (-40%)</button>
        </div>
      </section>

      <PlanCarousel plans={PLANS} yearly={yearly} />

      <Faq />

      <footer className="footer">
        <p>© 2026 Nimbus Hosting</p>
        <form className="newsletter" onSubmit={(e) => e.preventDefault()}>
          <input type="email" name="email" placeholder="you@company.com" aria-label="Email" required />
          <button type="submit">Keep me posted</button>
        </form>
      </footer>
    </>
  )
}

export default App
