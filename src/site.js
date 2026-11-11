/* Small behaviours for the public site: menu, announcement bar, slideshows, past events. */
(function () {
  var head = document.querySelector('.site-head');
  if (head) {
    var toggle = head.querySelector('.nav-toggle');
    toggle.addEventListener('click', function () {
      var open = head.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', open);
    });
    head.querySelectorAll('.has-sub > button').forEach(function (b) {
      b.addEventListener('click', function () {
        var li = b.parentNode, open = li.classList.toggle('open');
        b.setAttribute('aria-expanded', open);
        head.querySelectorAll('.has-sub.open').forEach(function (o) { if (o !== li) o.classList.remove('open'); });
      });
    });
    document.addEventListener('click', function (e) {
      if (!head.contains(e.target)) head.querySelectorAll('.has-sub.open').forEach(function (o) { o.classList.remove('open'); });
    });
  }

  var bar = document.querySelector('.announce');
  if (bar) {
    var key = 'announce:' + bar.getAttribute('data-announce'), hidden = false;
    try { hidden = localStorage.getItem(key) === '1'; } catch (e) {}
    if (hidden) bar.remove();
    else bar.querySelector('button').addEventListener('click', function () {
      bar.remove(); try { localStorage.setItem(key, '1'); } catch (e) {}
    });
  }

  document.querySelectorAll('[data-slides]').forEach(function (box) {
    var slides = box.querySelectorAll('.slide'), i = 0, timer;
    function show(n) { slides[i].classList.remove('on'); i = (n + slides.length) % slides.length; slides[i].classList.add('on'); }
    function auto() { clearInterval(timer); timer = setInterval(function () { show(i + 1); }, 6000); }
    box.querySelector('.sl-prev').addEventListener('click', function () { show(i - 1); auto(); });
    box.querySelector('.sl-next').addEventListener('click', function () { show(i + 1); auto(); });
    if (slides.length > 1) auto();
  });

  /* Hide events whose date has passed since the site was last published. */
  var d = new Date(), today = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  document.querySelectorAll('.event[data-end]').forEach(function (el) {
    if (el.getAttribute('data-end') < today) {
      var list = el.parentNode; el.remove();
      if (!list.children.length) list.outerHTML = '<p class="b-empty">No upcoming events right now. Check back soon!</p>';
    }
  });
})();
