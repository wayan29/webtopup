import axios from 'axios';

const API_URL = 'http://localhost:9005';

const testTransactionManager = async () => {
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

        // 2. Fetch Transactions
        console.log('Fetching Transactions...');
        const res = await axios.get(`${API_URL}/transactions`, { headers });
        const transactions = res.data as any[];
        console.log(`Found ${transactions.length} transactions.`);

        if (transactions.length > 0) {
            const trx = transactions[0];
            console.log('Updating status for:', trx._id);

            // 3. Update Status (Mocking a manual success update)
            // Note: If it's already success, this might not do much logic-wise but API should accept it.
            const updateRes = await axios.put(`${API_URL}/transactions/${trx._id}/status`, {
                status: 'success'
            }, { headers });

            console.log('Status Updated:', (updateRes.data as any).transaction.status);
        }

    } catch (error: any) {
        console.error('Test Failed:', error.response ? error.response.data : error.message);
    }
};

testTransactionManager();
