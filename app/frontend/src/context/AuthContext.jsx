import React, { createContext, useContext, useState, useEffect } from 'react';
import axios from '../api';
import { disconnectSocket } from '../socket';

const AuthContext = createContext(null);

const setAuthHeader = (token) => {
    if (token) {
        axios.defaults.headers.common['Authorization'] = 'Bearer ' + token;
    } else {
        delete axios.defaults.headers.common['Authorization'];
    }
};

export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [token, setToken] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        // Restore persisted session on mount.
        const storedToken = localStorage.getItem('romii_token');
        const storedUser = localStorage.getItem('romii_user');
        if (storedToken) {
            setToken(storedToken);
            setAuthHeader(storedToken);
        }
        if (storedUser) {
            try {
                setUser(JSON.parse(storedUser));
            } catch (e) {
                localStorage.removeItem('romii_user');
            }
        }
        setLoading(false);
    }, []);

    const login = (userData, newToken) => {
        setUser(userData);
        setToken(newToken);
        localStorage.setItem('romii_user', JSON.stringify(userData));
        if (newToken) localStorage.setItem('romii_token', newToken);
        setAuthHeader(newToken);
    };

    const logout = () => {
        setUser(null);
        setToken(null);
        localStorage.removeItem('romii_user');
        localStorage.removeItem('romii_token');
        setAuthHeader(null);
        // Tear down the live socket on logout (lifecycle owned by auth, opened by Layout).
        disconnectSocket();
    };

    return (
        <AuthContext.Provider value={{ user, token, login, logout, loading }}>
            {!loading && children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
