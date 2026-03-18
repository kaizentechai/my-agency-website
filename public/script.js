// Handle contact form submission
document.getElementById('contactForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const form = e.target;
    const btn = form.querySelector('button[type="submit"]');
    const messageDiv = document.getElementById('formMessage');
    
    const data = {
        name: document.getElementById('name').value,
        email: document.getElementById('email').value,
        phone: document.getElementById('phone').value,
        message: document.getElementById('message').value
    };
    
    // Disable button
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
    
    try {
        const res = await fetch('/api/contacts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        const result = await res.json();
        
        if (res.ok) {
            messageDiv.innerHTML = '<div class="alert alert-success">Thank you! We\'ll contact you soon.</div>';
            form.reset();
        } else {
            messageDiv.innerHTML = `<div class="alert alert-danger">${result.error || 'Failed to send'}</div>`;
        }
    } catch (err) {
        messageDiv.innerHTML = '<div class="alert alert-danger">Network error. Please try again.</div>';
    } finally {
        btn.disabled = false;
        btn.innerHTML = 'Send Message';
        
        // Clear message after 5 seconds
        setTimeout(() => {
            messageDiv.innerHTML = '';
        }, 5000);
    }
});

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({ behavior: 'smooth' });
        }
    });
});

// Navbar scroll effect
window.addEventListener('scroll', () => {
    const navbar = document.querySelector('.navbar');
    if (window.scrollY > 100) {
        navbar.style.padding = '0.5rem 0';
    } else {
        navbar.style.padding = '1rem 0';
    }
});