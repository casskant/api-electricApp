import express from 'express';
import { mapController } from '../controllers/mapController.js';

const router = express.Router();

router.post('/planTrip', mapController); 
// au besoin ajouter d'autre routes ici 

export default router;
