document.addEventListener('DOMContentLoaded', () => {
  const navbar = document.getElementById('navbar');
  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');
  const sections = document.querySelectorAll('section[id]');
  const backToTop = document.getElementById('backToTop');

  // Dynamic copyright year
  const yearEl = document.getElementById('copyrightYear');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // Combined scroll handler
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(() => {
        const scrollY = window.scrollY;
        navbar.classList.toggle('scrolled', scrollY > 50);
        if (backToTop) backToTop.classList.toggle('visible', scrollY > 600);

        let current = '';
        sections.forEach(section => {
          if (scrollY >= section.offsetTop - 140) {
            current = section.getAttribute('id');
          }
        });
        document.querySelectorAll('.nav-links a').forEach(link => {
          link.classList.toggle('active', link.getAttribute('href') === '#' + current);
        });
        ticking = false;
      });
      ticking = true;
    }
  }, { passive: true });

  // Mobile nav toggle
  navToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    navLinks.classList.toggle('active');
    navToggle.classList.toggle('active');
  });

  // Close mobile nav on link click
  navLinks.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') {
      navLinks.classList.remove('active');
      navToggle.classList.remove('active');
    }
  });

  // Close mobile nav on outside click
  document.addEventListener('click', (e) => {
    if (navLinks.classList.contains('active') && !navLinks.contains(e.target) && !navToggle.contains(e.target)) {
      navLinks.classList.remove('active');
      navToggle.classList.remove('active');
    }
  });

  // Back to top click
  if (backToTop) {
    backToTop.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // FAQ single-open accordion
  document.querySelectorAll('.faq-question').forEach(btn => {
    btn.addEventListener('click', () => {
      const parent = btn.parentElement;
      const wasOpen = parent.classList.contains('open');
      document.querySelectorAll('.faq-item.open').forEach(item => {
        item.classList.remove('open');
      });
      if (!wasOpen) parent.classList.add('open');
    });
  });

  // Smooth scroll for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.querySelector(anchor.getAttribute('href'));
      if (target) target.scrollIntoView({ behavior: 'smooth' });
    });
  });

  // Scroll animations
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) entry.target.classList.add('is-visible');
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

    document.querySelectorAll('.commitment-item, .advisory-card, .about-text, .services-text, .how-step, .testimonial-card, .trust-stat').forEach(el => {
      el.classList.add('animate-in');
      observer.observe(el);
    });
  }

  // Form handling via fetch (FormSubmit.co)
  const contactForm = document.getElementById('contactForm');
  const formStatus = document.getElementById('formStatus');
  if (contactForm) {
    contactForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = contactForm.querySelector('button[type="submit"]');
      const originalText = btn.textContent;
      btn.textContent = 'Sending...';
      btn.disabled = true;

      fetch(contactForm.action, {
        method: 'POST',
        body: new FormData(contactForm),
        headers: { 'Accept': 'application/json' }
      })
      .then(response => {
        if (response.ok) {
          contactForm.reset();
          if (formStatus) {
            formStatus.textContent = 'Message sent! We will be in touch within 24 hours.';
            formStatus.className = 'form-status success';
          }
        } else {
          throw new Error('Form submission failed');
        }
      })
      .catch(() => {
        if (formStatus) {
          formStatus.textContent = 'Something went wrong. Please call or WhatsApp us instead.';
          formStatus.className = 'form-status error';
        }
      })
      .finally(() => {
        btn.textContent = originalText;
        btn.disabled = false;
        setTimeout(() => { if (formStatus) formStatus.textContent = ''; }, 6000);
      });
    });
  }
});
