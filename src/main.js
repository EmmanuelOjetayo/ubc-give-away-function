import { Client, Databases, Query, ID } from 'node-appwrite';

export default async (context) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_FUNCTION_API_KEY);

  const databases = new Databases(client);

  // Configuration from Environment Variables
  const dbId = process.env.DATABASE_ID;
  const campColl = process.env.CAMPERS_COLLECTION;
  const payColl = process.env.PAYMENTS_COLLECTION;

  // 1. Safe Parse Input
  let payload = {};
  try {
    payload = typeof context.req.body === 'string' ? JSON.parse(context.req.body) : context.req.body;
  } catch (e) {
    return context.res.json({ success: false, message: 'Invalid JSON input' }, 400);
  }

  const { action, receiverId, senderId, amount } = payload;

  try {
    // --- ACTION: RESOLVE NAME ---
    if (action === 'resolve') {
      try {
        // METHOD A: getDocument (Most stable, avoids "Body" error)
        const user = await databases.getDocument(dbId, campColl, receiverId);
        return context.res.json({ success: true, name: user.name });
      } catch (err) {
        // METHOD B: listDocuments (Backup if the ID provided is not the document ID)
        const search = await databases.listDocuments(dbId, campColl, [
          Query.equal('$id', receiverId)
        ]);
        if (search.documents.length > 0) {
          return context.res.json({ success: true, name: search.documents[0].name });
        }
        throw new Error('User not found in any directory');
      }
    }

// --- ACTION: TRANSFER ---
    if (action === 'transfer') {
      const transferVal = parseFloat(amount);
      const TARGET_FEE = 4000;
      
      // 1. Fetch both parties
      const sender = await databases.getDocument(dbId, campColl, senderId);
      const receiver = await databases.getDocument(dbId, campColl, receiverId);

      // 2. Security: Sender must maintain at least 4,000 for their own fee
      const senderBalance = parseFloat(sender.amount_paid || 0);
      if (senderBalance - transferVal < TARGET_FEE) {
        return context.res.json({ 
          success: false, 
          message: `Transfer failed. You must keep ₦${TARGET_FEE} for your own camp fee.` 
        });
      }

      // 3. Update Sender (Subtract)
      await databases.updateDocument(dbId, campColl, senderId, {
        amount_paid: senderBalance - transferVal
      });

      // 4. Update Receiver & Check for Activation
      const receiverNewBalance = (parseFloat(receiver.amount_paid) || 0) + transferVal;
      
      let receiverPayload = {
        amount_paid: receiverNewBalance,
        status: receiverNewBalance >= TARGET_FEE ? 'paid' : 'pending'
      };

      // --- LOGISTICS AUTO-ASSIGNMENT ---
      // Triggered if they just hit 4k and don't have a team yet
      if (receiverNewBalance >= TARGET_FEE && !receiver.team) {
        const TEAMS = ["OPAJOBI", "ABIMBOLA", "ABIOLA", "UBC"];
        const BUSES = ["1", "2", "3", "4", "5"];

        // Get distribution counts
        const globalPaid = await databases.listDocuments(dbId, campColl, [
            Query.notEqual("team", ""),
            Query.limit(1)
        ]);
        
        const genderPaid = await databases.listDocuments(dbId, campColl, [
            Query.equal("gender", receiver.gender),
            Query.notEqual("bed_no", ""),
            Query.limit(1)
        ]);

        receiverPayload.team = TEAMS[globalPaid.total % TEAMS.length];
        receiverPayload.bus_no = BUSES[globalPaid.total % BUSES.length];
        
        const prefix = (receiver.gender === "Male" || receiver.gender === "M") ? "M" : "F";
        receiverPayload.bed_no = `${prefix}-${(genderPaid.total + 1).toString().padStart(3, '0')}`;
      }

      // Execute Receiver Update
      await databases.updateDocument(dbId, campColl, receiverId, receiverPayload);

      // 5. LOG HISTORY
      await databases.createDocument(dbId, payColl, ID.unique(), {
        camperId: senderId,
        amount: (-transferVal),
        reference: `SENT TO ${receiver.name.split(' ')[0]}`.toUpperCase(),
        date: new Date().toISOString()
      });

      await databases.createDocument(dbId, payColl, ID.unique(), {
        camperId: receiverId,
        amount: transferVal,
        reference: `FROM ${sender.name.split(' ')[0]}`.toUpperCase(),
        date: new Date().toISOString()
      });

      return context.res.json({ 
        success: true, 
        message: 'Transfer successful! Receiver logistics updated.' 
      });
    }
