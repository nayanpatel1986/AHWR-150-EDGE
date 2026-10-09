import { lazy } from 'react';

const isChunkLoadError = (error) => {
    const message = String(error?.message || error || '').toLowerCase();
    return error?.name === 'ChunkLoadError'
        || message.includes('loading chunk')
        || message.includes('failed to fetch dynamically imported module')
        || message.includes('importing a module script failed');
};

export const lazyWithRetry = (importer, chunkKey) => {
    const retryKey = `ahwr-150-twin-chunk-retry:${chunkKey}`;
    let preloadPromise = null;
    const load = () => {
        if (!preloadPromise) {
            preloadPromise = importer()
                .then((module) => {
                    sessionStorage.removeItem(retryKey);
                    return module;
                })
                .catch((error) => {
                    preloadPromise = null;
                    if (isChunkLoadError(error) && !sessionStorage.getItem(retryKey)) {
                        sessionStorage.setItem(retryKey, '1');
                        window.location.reload();
                        return new Promise(() => {});
                    }
                    sessionStorage.removeItem(retryKey);
                    throw error;
                });
        }
        return preloadPromise;
    };
    const Component = lazy(load);
    Component.preload = load;
    return Component;
};
