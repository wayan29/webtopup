import { lazy } from 'react';

export const Home = lazy(() => import('./Home'));
export const Products = lazy(() => import('./Products'));
export const Order = lazy(() => import('./Order'));
export const Leaderboard = lazy(() => import('./Leaderboard'));
export const Articles = lazy(() => import('./Articles'));
export const CheckTransaction = lazy(() => import('./CheckTransaction'));
export const Login = lazy(() => import('./Login'));
export const StaffLogin = lazy(() => import('./StaffLogin'));
export const Register = lazy(() => import('./Register'));
