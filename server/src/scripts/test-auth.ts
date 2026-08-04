import axios from 'axios';

const API_URL = 'http://localhost:9005/auth';

const testAuth = async () => {
    try {
        // 1. Register
        console.log('Testing Register...');
        const registerRes = await axios.post(`${API_URL}/register`, {
            name: 'Test User',
            email: `test${Date.now()}@example.com`,
            password: 'password123'
        });
        console.log('Register Success:', registerRes.data);

        const email = (registerRes.data as any).user.email;

        // 2. Login
        console.log('\nTesting Login...');
        const loginRes = await axios.post(`${API_URL}/login`, {
            email: email,
            password: 'password123'
        });
        console.log('Login Success:', loginRes.data);

        if ((loginRes.data as any).token) {
            console.log('\nToken received successfully!');
        } else {
            console.error('\nToken missing in login response');
            process.exit(1);
        }

    } catch (error: any) {
        console.error('Test Failed:', error.response ? error.response.data : error.message);
        process.exit(1);
    }
};

testAuth();
