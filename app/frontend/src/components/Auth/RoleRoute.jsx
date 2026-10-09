import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

// Renders nested routes only if the current user's role is in `allow`.
// Otherwise redirects to the home dashboard (already auth-gated by ProtectedRoute).
const RoleRoute = ({ allow = [] }) => {
    const { user } = useAuth();

    if (!user || !allow.includes(user.role)) {
        return <Navigate to="/" replace />;
    }

    return <Outlet />;
};

export default RoleRoute;
