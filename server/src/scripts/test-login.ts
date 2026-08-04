import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const API_BASE_URL = 'http://localhost:9005';

async function testAdminLogin() {
    try {
        console.log('Testing admin login flow...\n');
        
        // Test login with admin credentials
        const loginResponse = await axios.post(`${API_BASE_URL}/auth/login`, {
            email: 'admin@pobb.com',
            password: 'admin123456'
        });
        
        const { token, user } = loginResponse.data as { token: string; user: any };
        console.log('✅ Login successful!');
        console.log(`User: ${user.name} (${user.email})`);
        console.log(`Role: ${user.role}`);
        console.log(`Level: ${user.level}`);
        console.log(`Balance: Rp ${user.balance.toLocaleString('id-ID')}`);
        console.log(`Token received: ${token.substring(0, 50)}...`);
        
        // Test admin user endpoint (should be protected)
        const usersResponse = await axios.get(`${API_BASE_URL}/users`, {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });
        
        console.log(`\n✅ Admin access verified!`);
        console.log(`Users found: ${(usersResponse.data as any).users?.length || 0}`);
        
        console.log('\n🎯 Admin login flow test completed successfully!');
        console.log('Admin should be redirected to /admin dashboard after login.');
        
    } catch (error: any) {
        console.error('❌ Test failed:', error.response?.data?.message || error.message);
    }
}

testAdminLogin();
