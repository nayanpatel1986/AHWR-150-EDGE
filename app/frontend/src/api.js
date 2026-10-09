import axios from 'axios';

// Keep base relative ('') so nginx proxies /api and /socket.io in production.
axios.defaults.baseURL = '';
axios.defaults.timeout = 5000;

// Restore the Authorization header on hard reload (before React mounts) so the
// very first request after a refresh is authenticated.
const storedToken = localStorage.getItem('romii_token');
if (storedToken) {
    axios.defaults.headers.common['Authorization'] = 'Bearer ' + storedToken;
}

let handlingUnauthorized = false;

// Global response interceptor: on 401 clear auth and bounce to /login exactly once.
axios.interceptors.response.use(
    (response) => response,
    (error) => {
        const status = error?.response?.status;
        if (status === 401 && !handlingUnauthorized) {
            handlingUnauthorized = true;
            localStorage.removeItem('romii_token');
            localStorage.removeItem('romii_user');
            delete axios.defaults.headers.common['Authorization'];
            // Avoid redirect loops if we are already on the login screen.
            if (window.location.pathname !== '/login') {
                window.location.assign('/login');
            } else {
                handlingUnauthorized = false;
            }
        }
        return Promise.reject(error);
    }
);

export default axios;
