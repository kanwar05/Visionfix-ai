import React from 'react';
import './styles.css';

export function App() {
  return (
    <div className="shop-container">
      <header className="shop-header">
        <h1>Studio Minimalist Store</h1>
        <div className="notice-badge">
          Test Fixture — Not Product Interface
        </div>
      </header>

      <main>
        <section className="product-card">
          <h2 className="product-title">Ergonomic Mechanical Keyboard</h2>
          <p className="product-description">
            Custom engineered split keyboard with hot-swappable switches and CNC aluminum chassis.
          </p>
          <div className="product-price">$249.00</div>

          {/*
            INTENTIONAL DEFECT:
            The .product-specs-banner container has a hardcoded fixed width of 480px.
            When viewed on a 320px viewport, this forces the page document
            to horizontally overflow (scrollWidth >= 480px > 320px clientWidth).
          */}
          <div className="product-specs-banner" data-testid="intentional-overflow-container">
            <div className="product-specs-title">Technical Specifications</div>
            <div className="product-specs-grid">
              <div className="spec-item">
                <span className="spec-label">Layout</span>
                <span className="spec-value">65% Split Ortholinear</span>
              </div>
              <div className="spec-item">
                <span className="spec-label">Connectivity</span>
                <span className="spec-value">Tri-Mode Wireless / USB-C</span>
              </div>
              <div className="spec-item">
                <span className="spec-label">Battery</span>
                <span className="spec-value">4000mAh (200 hrs)</span>
              </div>
            </div>
          </div>

          <button
            type="button"
            className="checkout-btn"
            onClick={() => alert('Proceeding to checkout...')}
          >
            Proceed to Checkout ($249.00)
          </button>
        </section>
      </main>
    </div>
  );
}

export default App;
