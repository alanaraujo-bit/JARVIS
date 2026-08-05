// ---------- nav scroll state ----------
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 40);
}, { passive: true });

// ---------- mobile menu ----------
const navBurger = document.getElementById('navBurger');
const navMobile = document.getElementById('navMobile');
if (navBurger && navMobile) {
  navBurger.addEventListener('click', () => {
    const open = navMobile.classList.toggle('open');
    navBurger.setAttribute('aria-expanded', String(open));
    navBurger.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
  });
  navMobile.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
    navMobile.classList.remove('open');
    navBurger.setAttribute('aria-expanded', 'false');
  }));
}

const isSmallScreen = window.matchMedia('(max-width: 640px)').matches;

// ---------- reveal on scroll ----------
document.querySelectorAll('.section-head, .feature-card, .compare, .step, .deepcut, .faq-item').forEach(el => {
  el.setAttribute('data-reveal', '');
});
const io = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
}, { threshold: 0.12 });
document.querySelectorAll('[data-reveal]').forEach(el => io.observe(el));

// ---------- card tilt ----------
document.querySelectorAll('[data-tilt]').forEach(card => {
  card.addEventListener('mousemove', (e) => {
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    card.style.transform = `perspective(700px) rotateY(${x * 5}deg) rotateX(${-y * 5}deg) translateY(-4px)`;
  });
  card.addEventListener('mouseleave', () => { card.style.transform = ''; });
});

// ---------- 3D hero: particle terminal grid ----------
(function heroScene() {
  const canvas = document.getElementById('hero-canvas');
  if (!canvas || typeof THREE === 'undefined') return;
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !isSmallScreen, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isSmallScreen ? 1.5 : 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100);
  camera.position.set(0, 1.1, 7.2);

  function size() {
    const w = canvas.parentElement.clientWidth;
    const h = canvas.parentElement.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  size();
  window.addEventListener('resize', size);

  // particle field ("data" floating around a terminal core)
  const COUNT = isSmallScreen ? 380 : 900;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(COUNT * 3);
  const seeds = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    const radius = 2.6 + Math.random() * 4.2;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos((Math.random() * 2) - 1);
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.cos(phi) * 0.55;
    positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    seeds[i] = Math.random() * Math.PI * 2;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const colorA = new THREE.Color('#5eead4');
  const colorB = new THREE.Color('#fbbf24');
  const mat = new THREE.PointsMaterial({
    size: 0.045,
    color: colorA,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  scene.add(points);

  // wireframe core (a "terminal core" icosahedron)
  const coreGeo = new THREE.IcosahedronGeometry(1.5, 1);
  const coreMat = new THREE.MeshBasicMaterial({ color: colorA, wireframe: true, transparent: true, opacity: 0.35 });
  const core = new THREE.Mesh(coreGeo, coreMat);
  scene.add(core);

  const coreGeo2 = new THREE.IcosahedronGeometry(1.9, 0);
  const coreMat2 = new THREE.MeshBasicMaterial({ color: colorB, wireframe: true, transparent: true, opacity: 0.12 });
  const core2 = new THREE.Mesh(coreGeo2, coreMat2);
  scene.add(core2);

  // floating connective lines to suggest "network of terminals"
  const lineCount = isSmallScreen ? 18 : 40;
  const lineGeo = new THREE.BufferGeometry();
  const linePos = new Float32Array(lineCount * 2 * 3);
  for (let i = 0; i < lineCount; i++) {
    const a = Math.floor(Math.random() * COUNT);
    linePos[i * 6] = positions[a * 3];
    linePos[i * 6 + 1] = positions[a * 3 + 1];
    linePos[i * 6 + 2] = positions[a * 3 + 2];
    linePos[i * 6 + 3] = 0; linePos[i * 6 + 4] = 0; linePos[i * 6 + 5] = 0;
  }
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
  const lineMat = new THREE.LineBasicMaterial({ color: colorA, transparent: true, opacity: 0.06 });
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  scene.add(lines);

  let mouseX = 0, mouseY = 0;
  window.addEventListener('mousemove', (e) => {
    mouseX = (e.clientX / window.innerWidth - 0.5);
    mouseY = (e.clientY / window.innerHeight - 0.5);
  });

  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();
    if (!prefersReduced) {
      points.rotation.y = t * 0.05;
      core.rotation.y = t * 0.08;
      core.rotation.x = t * 0.04;
      core2.rotation.y = -t * 0.05;
      lines.rotation.y = t * 0.05;
    }
    camera.position.x += (mouseX * 1.2 - camera.position.x) * 0.02;
    camera.position.y += (1.1 - mouseY * 0.6 - camera.position.y) * 0.02;
    camera.lookAt(0, 0.2, 0);
    renderer.render(scene, camera);
  }
  animate();
})();

// ---------- download section: soft rising particles ----------
(function downloadScene() {
  const canvas = document.getElementById('download-canvas');
  if (!canvas || typeof THREE === 'undefined') return;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !isSmallScreen, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isSmallScreen ? 1.5 : 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 50);
  camera.position.set(0, 0, 6);

  function size() {
    const w = canvas.parentElement.clientWidth;
    const h = canvas.parentElement.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  size();
  window.addEventListener('resize', size);

  const COUNT = isSmallScreen ? 120 : 260;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(COUNT * 3);
  const speeds = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 12;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 6;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 6;
    speeds[i] = 0.2 + Math.random() * 0.5;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ size: 0.03, color: 0x5eead4, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
  const points = new THREE.Points(geo, mat);
  scene.add(points);

  let visible = false;
  const io2 = new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: 0.1 });
  io2.observe(canvas);

  function animate() {
    requestAnimationFrame(animate);
    if (!visible) return;
    const arr = geo.attributes.position.array;
    for (let i = 0; i < COUNT; i++) {
      arr[i * 3 + 1] += speeds[i] * 0.006;
      if (arr[i * 3 + 1] > 3.2) arr[i * 3 + 1] = -3.2;
    }
    geo.attributes.position.needsUpdate = true;
    points.rotation.y += 0.0006;
    renderer.render(scene, camera);
  }
  animate();
})();
