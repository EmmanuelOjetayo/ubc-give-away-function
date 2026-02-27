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
      
      // 1. Fetch both parties
      const sender = await databases.getDocument(dbId, campColl, senderId);
      const receiver = await databases.getDocument(dbId, campColl, receiverId);

      // 2. Security & Business Rules
      const senderBalance = parseFloat(sender.amount_paid || 0);
      if (senderBalance - transferVal < 4000) {
        return context.res.json({ 
          success: false, 
          message: 'Insufficient surplus. You must keep ₦4,000 for your camp fee.' 
        });
      }

      // 3. ATOMIC-LIKE UPDATES
      // Subtract from Sender
      await databases.updateDocument(dbId, campColl, senderId, {
        amount_paid: senderBalance - transferVal
      });

      // Add to Receiver
      await databases.updateDocument(dbId, campColl, receiverId, {
        amount_paid: (parseFloat(receiver.amount_paid) || 0) + transferVal
      });

      // 4. LOG HISTORY (Optional Fail-soft)
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
        context.error("History logged failed, but transfer succeeded.");
      }

      return context.res.json({ success: true, message: 'Transfer successful' });
    }

    return context.res.json({ success: false, message: 'Unknown action' });

  } catch (err) {
    context.error(err.message);
    return context.res.json({ success: false, message: err.message });
  }
};
