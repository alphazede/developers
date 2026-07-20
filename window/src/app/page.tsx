import Link from "next/link";

export default function Home() {
  return (
    <main className="landing-page">
      <header className="landing-nav">
        <span className="landing-brand"><span className="brand-dot" aria-hidden="true" />Pennyworth</span>
        <span className="landing-note">Local-first calendar</span>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">A calmer daily plan</p>
          <h1 id="hero-title">Make room for the work that matters.</h1>
          <p className="hero-lede">
            Protect focus periods, place work when capacity exists, and avoid stacking demanding meetings.
          </p>
          <Link className="hero-cta" href="/dashboard">Open your dashboard <span aria-hidden="true">→</span></Link>
          <p className="hero-assurance">Source tasks stay read-only. Schedule changes stay local previews.</p>
        </div>

        <aside className="hero-product" aria-label="Dashboard preview">
          <div className="hero-product__topline">
            <div><span>Today</span><strong>Your capacity, at a glance</strong></div>
            <span className="hero-status"><span aria-hidden="true" />Focus Gate open</span>
          </div>
          <div className="hero-product__timeline" aria-hidden="true">
            <span className="timeline-label timeline-label--start">9</span>
            <span className="timeline-label timeline-label--mid">12</span>
            <span className="timeline-label timeline-label--end">5</span>
            <span className="timeline-block timeline-block--focus">Protected focus</span>
            <span className="timeline-block timeline-block--work">Best capacity</span>
            <span className="timeline-block timeline-block--meeting">Meeting</span>
          </div>
          <div className="hero-product__footer">
            <div><span>Next best move</span><strong>Review imported follow-up</strong></div>
            <span>15:30 · local preview</span>
          </div>
        </aside>
      </section>
    </main>
  );
}
