// haze docs — shared behavior
document.documentElement.classList.add('js');

// Copy buttons: any element with data-copy="<text>"
document.querySelectorAll('[data-copy]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var text = btn.getAttribute('data-copy') || '';
    navigator.clipboard.writeText(text).then(function () {
      var prev = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(function () { btn.textContent = prev; btn.classList.remove('copied'); }, 1800);
    }).catch(function () {});
  });
});

// Codeblock copy buttons: copy the sibling <pre> text
document.querySelectorAll('.codeblock').forEach(function (block) {
  var btn = block.querySelector('.codeblock-copy');
  var pre = block.querySelector('pre');
  if (!btn || !pre) return;
  btn.addEventListener('click', function () {
    navigator.clipboard.writeText(pre.textContent || '').then(function () {
      var prev = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(function () { btn.textContent = prev; btn.classList.remove('copied'); }, 1800);
    }).catch(function () {});
  });
});

// Scroll reveal
var observer = new IntersectionObserver(function (entries) {
  entries.forEach(function (e) {
    if (e.isIntersecting) {
      e.target.classList.add('visible');
      observer.unobserve(e.target);
    }
  });
}, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

document.querySelectorAll('.reveal').forEach(function (el) { observer.observe(el); });
