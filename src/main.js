import { Client, Databases, Query, ID } from 'node-appwrite';

export default async (context) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_FUNCTION_API_KEY);

  const databases = new Databases(client);

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
      if (senderId && senderId === receiverId) {
      return context.res.json({ 
        success: false, 
        message: 'Illegal Operation: You cannot giveaway funds to yourself.' 
      });
    }
      try {
        const user = await databases.getDocument(dbId, campColl, receiverId);
        return context.res.json({ success: true, name: user.name });
      } catch (err) {
        const search = await databases.listDocuments(dbId, campColl, [
          Query.equal('$id', receiverId)
        ]);
        if (search.documents.length > 0) {
          return context.res.json({ success: true, name: search.documents[0].name });
        }
        throw new Error('User not found');
      }
    }

    // --- ACTION: TRANSFER ---
    if (action === 'transfer') {
      if (senderId === receiverId) {
        return context.res.json({ 
          success: false, 
          message: "Illegal Operation: You cannot send funds to your own account ID." 
        });
      }
      const transferVal = parseFloat(amount || 0);
      const TARGET_FEE = 5000;
      
      // 1. Fetch both parties
      const sender = await databases.getDocument(dbId, campColl, senderId);
      const receiver = await databases.getDocument(dbId, campColl, receiverId);

      // 2. Sender Balance Validation
      const senderBalance = parseFloat(sender.amount_paid || 0);
      if (senderBalance - transferVal < TARGET_FEE) {
        return context.res.json({ 
          success: false, 
          message: `Insufficient surplus. You must keep ₦${TARGET_FEE} for your own fee.` 
        });
      }

      // 3. Calculate New Balances
      const newSenderBalance = senderBalance - transferVal;
      const receiverCurrentBalance = parseFloat(receiver.amount_paid || 0);
      const receiverNewBalance = receiverCurrentBalance + transferVal;

      // 4. Prepare Receiver Payload
      let receiverPayload = {
        amount_paid: receiverNewBalance,
        status: receiverNewBalance >= TARGET_FEE ? 'paid' : 'pending'
      };

      // 5. LOGISTICS TRIGGER (If Receiver hits 4000)
      if (receiverNewBalance >= TARGET_FEE && !receiver.team) {
        const TEAMS = ["OPAJOBI", "ABIMBOLA", "ABIOLA", "UBC"];
        const BUSES = ["1", "2", "3", "4", "5"];

        // Query to see how many people are already assigned (for even distribution)
        const globalPaid = await databases.listDocuments(dbId, campColl, [
            Query.notEqual("team", ""),
            Query.limit(1)
        ]);
        
        // Query to find next bed number based on gender
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

      // 6. Execute Updates
      await databases.updateDocument(dbId, campColl, senderId, { amount_paid: newSenderBalance });
      await databases.updateDocument(dbId, campColl, receiverId, receiverPayload);

      // 7. LOG HISTORY
      try {
        await databases.createDocument(dbId, payColl, ID.unique(), {
          camperId: senderId,
          amount: -transferVal,
          reference: `SENT TO ${receiver.name.split(' ')[0]}`.toUpperCase()
        });
        await databases.createDocument(dbId, payColl, ID.unique(), {
          camperId: receiverId,
          amount: transferVal,
          reference: `FROM ${sender.name.split(' ')[0]}`.toUpperCase()
        });
      } catch (logErr) {
        context.error("History log failed, but funds moved.");
      }

      return context.res.json({ success: true, message: 'Transfer successful and logistics assigned' });
    }

    return context.res.json({ success: false, message: 'Unknown action' });

  } catch (err) {
    context.error(err.message);
    return context.res.json({ success: false, message: err.message });
  }
};
