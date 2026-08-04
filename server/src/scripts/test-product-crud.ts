import axios from 'axios';

const API_URL = 'http://localhost:9005';

const testProductCRUD = async () => {
    try {
        // 1. Login as Admin (We need to ensure we have an admin user)
        // Since we can't easily login as admin without seeding, we'll assume the seed script ran and we have a user.
        // Wait, the seed script creates a user with 'admin' role? Let's check seed.ts.
        // Ah, seed.ts creates 'admin' user with password 'admin123'.

        console.log('Logging in as Admin...');
        const loginRes = await axios.post(`${API_URL}/auth/login`, {
            email: 'admin@pobb.com',
            password: 'password123' // Wait, seed says password123 for all users? No, let's check.
            // Seed: const password = await bcrypt.hash('password123', 10);
            // Yes, password123.
        });
        const token = (loginRes.data as any).token;
        console.log('Admin Logged In.');

        const headers = { Authorization: `Bearer ${token}` };

        // 2. Create Product
        console.log('Creating Product...');
        const newProduct = {
            name: 'Test Product CRUD',
            code: 'TEST-CRUD-001',
            category: 'Games',
            brand: 'TestBrand',
            price: { basic: 10000, gold: 9500, platinum: 9000 },
            status: true
        };
        const createRes = await axios.post(`${API_URL}/products`, newProduct, { headers });
        const createdProduct = (createRes.data as any).product;
        console.log('Product Created:', createdProduct._id);

        // 3. Update Product
        console.log('Updating Product...');
        const updateRes = await axios.put(`${API_URL}/products/${createdProduct._id}`, {
            name: 'Test Product CRUD Updated'
        }, { headers });
        console.log('Product Updated:', (updateRes.data as any).product.name);

        // 4. Delete Product
        console.log('Deleting Product...');
        await axios.delete(`${API_URL}/products/${createdProduct._id}`, { headers });
        console.log('Product Deleted.');

    } catch (error: any) {
        console.error('Test Failed:', error.response ? error.response.data : error.message);
    }
};

testProductCRUD();
