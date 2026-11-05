/* Keep downloads and video decoding close to the viewport, including scroll galleries. */
(() => {
    const videos = [...document.querySelectorAll('video[data-lazy-video]')];
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const connection = navigator.connection;
    const visible = new Set();
    const automatic = () => !motion.matches && !connection?.saveData;

    function hydrate(video) {
        if (video.dataset.loaded) return;
        video.dataset.loaded = 'true';
        video.querySelectorAll('source[data-src]').forEach(source => {
            source.src = source.dataset.src;
        });
        video.load();
    }

    function update(video) {
        if (document.hidden || !visible.has(video)) {
            video.pause();
            return;
        }
        if (!automatic()) {
            video.controls = true;
            return;
        }
        hydrate(video);
        video.muted = true;
        video.play().then(() => {
            // Preferences and visibility can change while play() is pending.
            if (document.hidden || !visible.has(video) || !automatic()) video.pause();
            else video.controls = false;
        }).catch(() => { video.controls = true; });
    }

    videos.forEach(video => {
        // Native controls remain available if autoplay is blocked or motion is reduced.
        video.addEventListener('pointerdown', () => hydrate(video), { once: true });
        video.addEventListener('keydown', () => hydrate(video), { once: true });
    });

    if (!('IntersectionObserver' in window)) {
        videos.forEach(video => {
            video.poster = video.dataset.poster;
            hydrate(video);
            video.controls = true;
        });
        return;
    }

    const nearby = new IntersectionObserver(entries => entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const video = entry.target;
        video.poster = video.dataset.poster;
        nearby.unobserve(video);
    }), { rootMargin: '300px 0px' });

    const playback = new IntersectionObserver(entries => entries.forEach(entry => {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.1) {
            visible.add(entry.target);
            // preload=none prevents a download until play() or an explicit user action.
            hydrate(entry.target);
        } else visible.delete(entry.target);
        update(entry.target);
    }), { threshold: [0, 0.1] });

    videos.forEach(video => { nearby.observe(video); playback.observe(video); });
    document.addEventListener('visibilitychange', () => videos.forEach(update));
    const preferencesChanged = () => videos.forEach(video => {
        if (!automatic()) video.pause();
        update(video);
    });
    motion.addEventListener('change', preferencesChanged);
    connection?.addEventListener('change', preferencesChanged);
})();
