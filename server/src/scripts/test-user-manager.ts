import axios from 'axios';

const API_URL = 'http://localhost:9005';

const testUserManager = async () => {
    try {
        // 1. Login as Admin
        console.log('Logging in as Admin...');
        const loginRes = await axios.post(`${API_URL}/auth/login`, {
            email: 'admin@pobb.com',
            password: 'password123'
        });
        const token = (loginRes.data as any).token;
        console.log('Admin Logged In.');
        const headers = { Authorization: `Bearer ${token}` };

        // 2. Fetch Users
        console.log('Fetching Users...');
        const res = await axios.get(`${API_URL}/users`, { headers });
        const users = res.data as any[];
        console.log(`Found ${users.length} users.`);

        if (users.length > 0) {
            const user = users[0];
            console.log('Updating user:', user.email);

            // 3. Update User Level (e.g., upgrade to Gold)
            const updateRes = await axios.put(`${API_URL}/users/${user._id}`, {
                level: 'gold'
            }, { headers });

            console.log('User Updated:', (updateRes.data as any).user.level);
        }

    } catch (error: any) {
        console.error('Test Failed:', error.response ? error.response.data : error.message);
    }
};

testUserManager();
