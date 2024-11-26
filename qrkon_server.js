const path = require('path');
require('dotenv').config();

// Construct absolute path to serviceAccountKey.json
process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, process.env.GOOGLE_APPLICATION_CREDENTIALS);

const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const { connectToDatabase, saveContactCard, getContactCards, getContactCardById, deleteContactCard, addContactToUser, getUserContacts, getContactCardsById, updateCardImage } = require('./db');
const { Storage } = require('@google-cloud/storage');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 3001;

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: 'https://qrkon1.firebaseio.com'
});

app.use(cors());
app.use(bodyParser.json());

// Middleware to verify Firebase auth token
const verifyToken = async (req, res, next) => {
  const idToken = req.headers.authorization;
  if (!idToken) {
    return res.status(403).json({ error: 'No token provided' });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    res.status(403).json({ error: 'Invalid token' });
  }
};

// Connect to MongoDB when the server starts
connectToDatabase().catch(console.error);

// Add this new route to create a new card
app.post('/api/create-card', verifyToken, async (req, res) => {
  const userId = req.user.uid;
  const newCardId = uuidv4();

  try {
    const newCard = {
      _id: newCardId,
      userId,
      name: '',
      description: '',
      contactDetails: []
    };
    await saveContactCard(newCard);
    res.json({ success: true, _id: newCardId });
  } catch (error) {
    console.error('Error creating new card:', error);
    res.status(500).json({ success: false, message: 'Error creating new card' });
  }
});

// Update the existing save-contact route
app.post('/api/save-contact-card', verifyToken, async (req, res) => {
  const { cardId, contactData } = req.body;
  const userId = req.user.uid;

  try {
    // Function to truncate text fields
    const truncateText = (text) => text.substring(0, 500);
    const truncateLongText = (text) => text.substring(0, 3000);

    // Truncate name and description
    const truncatedContactData = {
      ...contactData,
      name: truncateText(contactData.name || ''),
      description: truncateLongText(contactData.description || ''),
      contactDetails: contactData.contactDetails.map(detail => ({
        ...detail,
        value: truncateText(detail.value || '')
      }))
    };

    const updatedCard = {
      _id: cardId,
      userId,
      ...truncatedContactData,
    };
    await saveContactCard(updatedCard);
    res.json({ success: true, message: 'Contact details saved successfully' });
  } catch (error) {
    console.error('Error saving contact details:', error);
    res.status(500).json({ success: false, message: 'Error saving contact details' });
  }
});

// Add this new route to retrieve contact cards
app.get('/api/get-contact-cards', verifyToken, async (req, res) => {
  const userId = req.user.uid;

  try {
    const cards = await getContactCards(userId);
    res.json({ success: true, cards });
  } catch (error) {
    console.error('Error retrieving contact cards:', error);
    res.status(500).json({ success: false, message: 'Error retrieving contact cards' });
  }
});

// Add this new route to retrieve a specific card
app.get('/api/get-card/:cardId', verifyToken, async (req, res) => {
  const { cardId } = req.params;
  const userId = req.user.uid;

  try {
    const card = await getContactCardById(cardId);
    if (!card) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }
    const isOwner = card.userId === userId;
    res.json({ success: true, card, isOwner });
  } catch (error) {
    console.error('Error retrieving contact card:', error);
    res.status(500).json({ success: false, message: 'Error retrieving contact card' });
  }
});

// Add this new route to delete a card
app.delete('/api/delete-card/:cardId', verifyToken, async (req, res) => {
  const { cardId } = req.params;
  const userId = req.user.uid;

  try {
    const result = await deleteContactCard(cardId, userId);
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Card not found or you do not have permission to delete it' });
    }
    res.json({ success: true, message: 'Card deleted successfully' });
  } catch (error) {
    console.error('Error deleting contact card:', error);
    res.status(500).json({ success: false, message: 'Error deleting contact card' });
  }
});

app.post('/api/add-contact', verifyToken, async (req, res) => {
  const { contactId } = req.body;
  const userId = req.user.uid;

  try {
    await addContactToUser(userId, contactId);
    res.json({ success: true, message: 'Contact added successfully' });
  } catch (error) {
    console.error('Error adding contact:', error);
    res.status(500).json({ success: false, message: 'Error adding contact' });
  }
});

app.get('/api/get-user-contacts', verifyToken, async (req, res) => {
  const userId = req.user.uid;

  try {
    const contactIds = await getUserContacts(userId);
    const contactCards = await getContactCardsById(contactIds);
    res.json({ success: true, contacts: contactCards });
  } catch (error) {
    console.error('Error retrieving user contacts:', error);
    res.status(500).json({ success: false, message: 'Error retrieving user contacts' });
  }
});

// Configure multer for file uploads
const storage = new Storage();
const bucket = storage.bucket(process.env.GCP_STORAGE_BUCKET);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // limit file size to 5MB
  },
});

// Add this new route to handle image uploads
app.post('/api/upload-image', verifyToken, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }

  const userId = req.user.uid;
  const cardId = req.body.cardId;

  try {
    // Check if the file is an image
    if (!req.file.mimetype.startsWith('image/')) {
      return res.status(400).json({ success: false, message: 'Only image files are allowed' });
    }

    // Get the existing card to check for old image
    const existingCard = await getContactCardById(cardId);
    
    // Delete old image if it exists
    if (existingCard && existingCard.imageUrl) {
      const oldFileName = existingCard.imageUrl.split('/').pop();
      await bucket.file(oldFileName).delete().catch(console.error);
    }

    const fileName = `${userId}_${cardId}_${Date.now()}.jpg`;
    const file = bucket.file(fileName);

    const stream = file.createWriteStream({
      metadata: {
        contentType: 'image/jpeg',
      },
    });

    stream.on('error', (err) => {
      console.error('Error uploading to GCS:', err);
      res.status(500).json({ success: false, message: 'Error uploading image' });
    });

    stream.on('finish', async () => {
      try {
        await file.makePublic();
        const imageUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
        await updateCardImage(cardId, imageUrl);
        res.json({ success: true, imageUrl });
      } catch (error) {
        console.error('Error updating card with image URL:', error);
        res.status(500).json({ success: false, message: 'Error updating card with image URL' });
      }
    });

    stream.end(req.file.buffer);
  } catch (error) {
    console.error('Error handling image upload:', error);
    res.status(500).json({ success: false, message: 'Error handling image upload' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
