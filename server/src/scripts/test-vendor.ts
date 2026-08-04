import vendorService from '../services/vendorService';

const testVendor = async () => {
    console.log('Testing vendor adapter...');

    // 1. Check Balance
    const balance = await vendorService.getBalance(process.env.VENDOR_PROVIDER);
    console.log('Agent Balance:', balance);

    // 2. Mock Top Up (Since we don't have real credentials, this will likely fail or return error)
    // But we want to see the adapter trying to connect.
    console.log('Attempting Top Up...');
    const res = await vendorService.topUp('TEST-TRX-' + Date.now(), 'PULSA5000', '08123456789', process.env.VENDOR_PROVIDER);
    console.log('Top Up Result:', res);
};

testVendor();
