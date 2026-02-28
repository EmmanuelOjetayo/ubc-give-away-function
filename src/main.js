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

  // 1. Safe Parse Input - Prevents "Unexpected end of JSON" crash
  let payload = {};
  if (context.req.body) {
    try {
      payload = typeof context.req.body === 'string' ? JSON.parse(context.req.body) : context.req.body;
    } catch (e) {
      return context.res.json({ success: false, message: 'Malformed JSON input' }, 400);
    }
  } else {
    return context.res.json({ success: false, message: 'Empty request body' }, 400);
  }

  const { action, receiverId, senderId, amount } = payload;

  try {
    // --- ACTION: RESOLVE NAME ---
    if (action === 'resolve') {
      const user = await databases.getDocument(dbId, campColl, receiverId);
      return context.res.json({ success: true, name: user.name });
    }

    // --- ACTION: TRANSFER ---
    if (action === 'transfer') {
      const transferVal = parseFloat(amount || 0);
      const TARGET_FEE = 4000;
      
      if (transferVal <= 0) return context.res.json({ success: false, message: 'Invalid amount' });

      // 1. Fetch both parties
      const sender = await databases.getDocument(dbId, campColl, senderId);
      const receiver = await databases.getDocument(dbId, campColl, receiverId);

      // 2. Security: Check Sender Balance
      const senderBalance = parseFloat(sender.amount_paid || 0);
      if (senderBalance - transferVal < TARGET_FEE) {
        return context.res.json({ 
          success: false, 
          message: `Transfer failed. You must keep ₦${TARGET_FEE} for your own fee.` 
        });
      }

      // 3. Subtract from Sender
      await databases.updateDocument(dbId, campColl, senderId, {
        amount_paid: senderBalance - transferVal
      });

      // 4. Update Receiver & Check Activation
      const receiverCurrentBalance = parseFloat(receiver.amount_paid || 0);
      const receiverNewBalance = receiverCurrentBalance + transferVal;
      
      let receiverPayload = {
        amount_paid: receiverNewBalance,
        status: receiverNewBalance >= TARGET_FEE ? 'paid' : 'pending'
      };

      // --- LOGISTICS AUTO-ASSIGNMENT ---
      if (receiverNewBalance >= TARGET_FEE && !receiver.team) {
        const TEAMS = ["OPAJOBI", "ABIMBOLA", "ABIOLA", "UBC"];
        const BUSES = ["1", "2", "3", "4", "5"];

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

      await databases.updateDocument(dbId, campColl, receiverId, receiverPayload);

      // 5. LOG HISTORY
      // Using raw numbers (parseFloat), no toString() as requested
      await databases.createDocument(dbId, payColl, ID.unique(), {
        camperId: senderId,
        amount: -transferVal,
        reference: `SENT TO ${receiver.name.split(' ')[0]}`.toUpperCase(),
        date: new Date().toISOString()
      });

      await databases.createDocument(dbId, payColl, ID.unique(), {
        camperId: receiverId,
        amount: transferVal,
        reference: `FROM ${sender.name.split(' ')[0]}`.toUpperCase(),
        date: new Date().toISOString()
      });

      return context.res.json({ success: true, message: 'Transfer successful!' });
    }

    return context.res.json({ success: false, message: 'Unknown action' });

  } catch (err) {
    context.error(err.message);
    return context.res.json({ success: false, message: err.message }, 500);
  }
};
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
