import axios from 'axios';

const API_URL = 'http://localhost:9005';

const testProduct = async () => {
    try {
        // 1. Login as Admin (using the user created in seed.ts or test-auth.ts)
        // We'll create a new admin user to be sure
        console.log('Creating Admin User...');
        const email = `admin${Date.now()}@pobb.com`;
        try {
            await axios.post(`${API_URL}/auth/register`, {
                name: 'Admin Product',
                email: email,
                password: 'password123'
            });
        } catch (e) { } // Ignore if exists

        console.log('Logging in as Admin...');
        // Note: In a real app, we'd need to manually set the role to 'admin' in DB
        // For this test, we assume the seed script created an admin user 'admin@pobb.com'
        const loginRes = await axios.post(`${API_URL}/auth/login`, {
            email: email,
            password: 'password123'
        });

        // Actually, let's just register a new user and manually update role to admin via direct DB access if possible?
        // No, let's just use the 'register' endpoint which creates a 'member'.
        // We need a way to test Admin routes.
        // For now, let's just test Public routes first.

        console.log('Testing Public Routes...');
        const productsRes = await axios.get(`${API_URL}/products`);
        console.log('Get Products Success:', (productsRes.data as any).length, 'products found');

        if ((productsRes.data as any).length > 0) {
            const productId = (productsRes.data as any)[0]._id;
            const productRes = await axios.get(`${API_URL}/products/${productId}`);
            console.log('Get Single Product Success:', (productRes.data as any).name);
        }

    } catch (error: any) {
        console.error('Test Failed:', error.response ? error.response.data : error.message);
    }
};

testProduct();
