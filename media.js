/* Keep downloads and video decoding close to the viewport, including scroll galleries. */
(() => {
    const videos = [...document.querySelectorAll('video[data-lazy-video]')];
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const connection = navigator.connection;
    const visible = new Set();
    const attempts = new WeakMap();
    const blocked = new WeakSet();
    const automatic = () => !motion.matches && !connection?.saveData;

    // Space Day uses a keyboard-accessible button inside its circular mask.
    // All other videos retain their existing native-control behavior.
    function setControls(video, enabled) {
        if (!video.hasAttribute('data-custom-controls')) {
            video.controls = enabled;
            return;
        }
        video.controls = false;
        const button = video.parentElement.querySelector('.space-day-play');
        if (button) button.hidden = !enabled;
    }

    function hydrate(video) {
        // Set the poster before assigning src, including on a fast scroll past the nearby observer.
        if (!video.poster) video.poster = video.dataset.poster;
        if (video.dataset.loaded) return;
        video.dataset.loaded = 'true';
        // Assigning the media URL lets native controls initialize while respecting preload=none.
        const source = video.querySelector('source');
        const variants = JSON.parse(source.dataset.variants || '[]');
        // Choose once, before any MP4 request. Keep the chosen source when scrolling/resizing.
        const box = video.getBoundingClientRect();
        const aspect = Number(video.getAttribute('width')) / Number(video.getAttribute('height'));
        const displayWidth = getComputedStyle(video).objectFit === 'cover'
            ? Math.max(box.width, box.height * aspect) : box.width;
        const requiredWidth = displayWidth * Math.min(devicePixelRatio || 1, 2);
        video.src = (variants.find(variant => variant.width >= requiredWidth) || variants.at(-1))?.src || source.dataset.src;
    }

    function update(video) {
        setControls(video, !automatic() || blocked.has(video));
        if (document.hidden || !visible.has(video)) {
            attempts.delete(video);
            video.pause();
            return;
        }
        if (!automatic() || blocked.has(video) || attempts.has(video)) return;
        // Never enable native controls while the automatic play request is pending.
        setControls(video, false);
        hydrate(video);
        video.muted = true;
        const attempt = {};
        attempts.set(video, attempt);
        video.play().then(() => {
            if (attempts.get(video) !== attempt) return;
            attempts.delete(video);
            // Preferences and visibility can change while play() is pending.
            if (document.hidden || !visible.has(video) || !automatic()) video.pause();
            else setControls(video, false);
        }).catch(error => {
            if (attempts.get(video) !== attempt) return;
            attempts.delete(video);
            // pause() during scrolling can cancel play(); that is not an autoplay denial.
            if (error.name === 'AbortError' || document.hidden || !visible.has(video)) return;
            blocked.add(video);
            setControls(video, true);
        });
    }

    videos.filter(video => video.hasAttribute('data-custom-controls')).forEach(video => {
        const button = video.parentElement.querySelector('.space-day-play');
        button.addEventListener('click', async () => {
            button.disabled = true;
            hydrate(video);
            video.muted = true;
            try {
                await video.play();
                if (document.hidden || ('IntersectionObserver' in window && !visible.has(video))) {
                    video.pause();
                } else setControls(video, false);
            } catch {
                setControls(video, true);
            } finally {
                button.disabled = false;
            }
        });
    });

    if (!('IntersectionObserver' in window)) {
        videos.forEach(video => {
            video.poster = video.dataset.poster;
            hydrate(video);
            setControls(video, true);
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
