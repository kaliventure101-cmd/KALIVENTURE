require('dotenv').config();

const cors = require('cors');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SECRET_KEY, PORT = 4000 } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in KALIVENTURE-API/.env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const KALIBO_BOUNDS = { south: 11.62, west: 122.30, north: 11.78, east: 122.43 };

async function loadReviewUserNames(userIds) {
  const names = new Map();
  const ids = new Set(userIds.filter(Boolean).map(String));
  if (!ids.size) return names;

  let page = 1;
  const perPage = 1000;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    (data?.users || []).forEach((user) => {
      if (!ids.has(String(user.id))) return;
      const metadata = user.user_metadata || {};
      names.set(String(user.id), metadata.full_name || metadata.name || metadata.username || user.email?.split('@')[0] || 'Traveler');
    });
    const users = data?.users || [];
    if (users.length < perPage || page * perPage >= (data?.total || 0)) break;
    page += 1;
  }
  return names;
}

function insideKalibo(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= KALIBO_BOUNDS.south && latitude <= KALIBO_BOUNDS.north
    && longitude >= KALIBO_BOUNDS.west && longitude <= KALIBO_BOUNDS.east;
}

async function geocodeKalibo(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&bounded=1&viewbox=${KALIBO_BOUNDS.west},${KALIBO_BOUNDS.north},${KALIBO_BOUNDS.east},${KALIBO_BOUNDS.south}&q=${encodeURIComponent(`${query}, Kalibo, Aklan`)}`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Kaliventure/1.0 contact@kaliventure.local' } });
  if (!response.ok) return null;
  const result = (await response.json())[0];
  const latitude = Number(result?.lat);
  const longitude = Number(result?.lon);
  return insideKalibo(latitude, longitude) ? { address: result.display_name, latitude, longitude } : null;
}

async function requireUser(request, response, next) {
  const authorization = request.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) return response.status(401).json({ error: 'Sign in is required.' });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return response.status(401).json({ error: 'Your session is invalid or expired.' });
  request.currentUser = data.user;
  return next();
}

app.get('/health', (_request, response) => response.json({ ok: true }));

app.get('/api/places', async (_request, response) => {
  const places = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('destinations')
      .select('id, name, category, distance, address, latitude, longitude, description, image_url, rating, reviews, created_at')
      .eq('is_published', true)
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (error) return response.status(500).json({ error: 'Could not load destinations.' });
    places.push(...(data || []));
    if (!data || data.length < pageSize) break;
    offset += pageSize;
  }
  return response.json(places);
});

app.get('/api/reviews/:destinationId', async (request, response) => {
  const reviews = [];
  const pageSize = 5000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('place_reviews')
      .select('id, destination_id, user_id, rating, comment, created_at')
      .eq('destination_id', request.params.destinationId)
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (error) return response.status(500).json({ error: 'Could not load reviews.' });
    reviews.push(...(data || []));
    if (!data || data.length < pageSize) break;
    offset += pageSize;
  }
  const uniqueReviews = new Map();
  reviews.forEach((review) => uniqueReviews.set(String(review.id), review));
  const publicReviews = Array.from(uniqueReviews.values());
  let userNames = new Map();
  try {
    userNames = await loadReviewUserNames(publicReviews.map((review) => review.user_id));
  } catch (_error) {
    return response.status(500).json({ error: 'Could not load reviewer names.' });
  }
  return response.json(publicReviews.map((review) => ({
    ...review,
    user_name: userNames.get(String(review.user_id)) || 'Traveler',
  })));
});

app.post('/api/reviews', requireUser, async (request, response) => {
  const { destination_id: destinationId, rating, comment } = request.body || {};
  const numericRating = Number(rating);
  if (!destinationId || !Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5 || typeof comment !== 'string' || !comment.trim() || comment.length > 1000) {
    return response.status(400).json({ error: 'Choose a rating and write a comment.' });
  }
  const { data, error } = await supabase.from('place_reviews').insert({
    destination_id: destinationId,
    user_id: request.currentUser.id,
    rating: numericRating,
    comment: comment.trim(),
  }).select('id, destination_id, user_id, rating, comment, created_at').single();
  if (error) return response.status(500).json({ error: 'Could not save your review. Run the Supabase migration first.' });
  return response.status(201).json({ review: data });
});

async function requireAdmin(request, response, next) {
  const authorization = request.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) return response.status(401).json({ error: 'Sign in is required.' });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return response.status(401).json({ error: 'Your session is invalid or expired.' });
  if (data.user.app_metadata?.role !== 'admin') return response.status(403).json({ error: 'Admin access is required.' });
  request.adminUser = data.user;
  return next();
}

app.get('/api/admin/reviews', requireAdmin, async (_request, response) => {
  const reviews = [];
  const pageSize = 5000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('place_reviews')
      .select('id, destination_id, user_id, rating, comment, created_at')
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);
  if (error) return response.status(500).json({ error: 'Could not load place reviews.' });
    reviews.push(...(data || []));
    if (!data || data.length < pageSize) break;
    offset += pageSize;
  }

  const destinations = [];
  let destinationOffset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('destinations')
      .select('id, name')
      .range(destinationOffset, destinationOffset + pageSize - 1);
    if (error) return response.status(500).json({ error: 'Could not load review destinations.' });
    destinations.push(...(data || []));
    if (!data || data.length < pageSize) break;
    destinationOffset += pageSize;
  }
  const destinationNames = new Map((destinations || []).map((place) => [String(place.id), place.name]));
  let userNames = new Map();
  try {
    userNames = await loadReviewUserNames(reviews.map((review) => review.user_id));
  } catch (_error) {
    return response.status(500).json({ error: 'Could not load review user names.' });
  }
  return response.json({
    reviews: Array.from(new Map(reviews.map((review) => [String(review.id), review])).values()).map((review) => ({
      ...review,
      destination_name: destinationNames.get(String(review.destination_id)) || 'Unknown destination',
      user_name: userNames.get(String(review.user_id)) || 'Traveler',
    })),
  });
});

app.patch('/api/admin/reviews/:reviewId', requireAdmin, async (request, response) => {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(request.params.reviewId)) {
    return response.status(400).json({ error: 'Review ID is invalid.' });
  }
  const { rating, comment } = request.body || {};
  const numericRating = Number(rating);
  if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5
    || typeof comment !== 'string' || !comment.trim() || comment.length > 1000) {
    return response.status(400).json({ error: 'Choose a rating from 1 to 5 and enter a comment up to 1000 characters.' });
  }

  const { data, error } = await supabase
    .from('place_reviews')
    .update({ rating: numericRating, comment: comment.trim() })
    .eq('id', request.params.reviewId)
    .select('id, destination_id, user_id, rating, comment, created_at')
    .maybeSingle();
  if (error) return response.status(500).json({ error: 'Could not update this review.' });
  if (!data) return response.status(404).json({ error: 'Review not found.' });
  return response.json({ review: data });
});

app.delete('/api/admin/reviews/:reviewId', requireAdmin, async (request, response) => {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(request.params.reviewId)) {
    return response.status(400).json({ error: 'Review ID is invalid.' });
  }
  const { data, error } = await supabase
    .from('place_reviews')
    .delete()
    .eq('id', request.params.reviewId)
    .select('id');
  if (error) return response.status(500).json({ error: 'Could not delete this review.' });
  if (!data?.length) return response.status(404).json({ error: 'Review not found or it could not be deleted.' });
  return response.json({ ok: true });
});

app.get('/api/admin/users', requireAdmin, async (_request, response) => {
  const users = [];
  let page = 1;
  while (page <= 100) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
    if (error) return response.status(500).json({ error: 'Could not load user accounts.' });
    const pageUsers = data?.users || [];
    users.push(...pageUsers);
    if (!pageUsers.length || (data.lastPage && page >= data.lastPage) || pageUsers.length < 100) break;
    page += 1;
  }
  const normalizedUsers = users.map((user) => ({
    id: user.id,
    email: user.email || null,
    created_at: user.created_at,
    last_sign_in_at: user.last_sign_in_at,
    email_confirmed_at: user.email_confirmed_at,
  })).sort((first, second) => new Date(second.created_at || 0) - new Date(first.created_at || 0));
  return response.json({ users: normalizedUsers, count: normalizedUsers.length, total: normalizedUsers.length, pageSize: 100 });
});

app.delete('/api/admin/users/:userId', requireAdmin, async (request, response) => {
  if (request.params.userId === request.adminUser.id) {
    return response.status(400).json({ error: 'You cannot delete the account currently running the admin dashboard.' });
  }
  const { error } = await supabase.auth.admin.deleteUser(request.params.userId);
  if (error) return response.status(500).json({ error: 'Could not delete this user account.' });
  return response.json({ ok: true });
});

app.get('/api/admin/places', requireAdmin, async (_request, response) => {
  const places = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('destinations')
      .select('id, name, category, distance, address, latitude, longitude, description, image_url, rating, reviews, created_at')
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (error) return response.status(500).json({ error: 'Could not load destinations.' });
    places.push(...(data || []));
    if (!data || data.length < pageSize) break;
    offset += pageSize;
  }
  return response.json({ places });
});

app.post('/api/admin/places', requireAdmin, async (request, response) => {
  const { name, category, distance, address, latitude, longitude, description, image_url: imageUrl } = request.body || {};
  if (typeof name !== 'string' || !name.trim() || typeof category !== 'string' || !category.trim()) {
    return response.status(400).json({ error: 'Place name and category are required.' });
  }
  if (name.length > 120 || category.length > 80 || (description && (typeof description !== 'string' || description.length > 2000))) {
    return response.status(400).json({ error: 'Some place details are too long.' });
  }
  if (imageUrl) {
    try {
      const parsed = new URL(imageUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid URL');
    } catch (_error) {
      return response.status(400).json({ error: 'Image URL must be a valid http or https URL.' });
    }
  }

  const hasLatitude = latitude !== undefined && latitude !== null && String(latitude).trim() !== '';
  const hasLongitude = longitude !== undefined && longitude !== null && String(longitude).trim() !== '';
  if (hasLatitude !== hasLongitude) {
    return response.status(400).json({ error: 'Choose both latitude and longitude for the destination.' });
  }

  let numericLatitude = hasLatitude ? Number(latitude) : NaN;
  let numericLongitude = hasLongitude ? Number(longitude) : NaN;
  let normalizedAddress = typeof address === 'string' ? address.trim().slice(0, 240) : '';
  if (!hasLatitude) {
    const geocoded = await geocodeKalibo(normalizedAddress || name).catch(() => null);
    if (geocoded) {
      normalizedAddress = geocoded.address;
      numericLatitude = geocoded.latitude;
      numericLongitude = geocoded.longitude;
    }
  }
  if (hasLatitude && !insideKalibo(numericLatitude, numericLongitude)) {
    return response.status(400).json({ error: 'The location must be inside Kalibo, Aklan.' });
  }

  const { data, error } = await supabase.from('destinations').insert({
    name: name.trim(),
    category: category.trim(),
    distance: typeof distance === 'string' && distance.trim() ? distance.trim().slice(0, 40) : 'Nearby',
    address: normalizedAddress || null,
    latitude: Number.isFinite(numericLatitude) ? numericLatitude : null,
    longitude: Number.isFinite(numericLongitude) ? numericLongitude : null,
    description: typeof description === 'string' ? description.trim() : '',
    image_url: imageUrl || null,
    is_published: true,
  }).select('id, name, category, distance, address, latitude, longitude, description, image_url, rating, reviews, created_at').single();
  if (error) return response.status(500).json({ error: 'Could not save this place. Make sure the database setup SQL has been applied.' });
  return response.status(201).json({ place: data });
});

app.patch('/api/admin/places/:placeId', requireAdmin, async (request, response) => {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(request.params.placeId)) {
    return response.status(400).json({ error: 'Destination ID is invalid.' });
  }
  const allowedFields = ['name', 'category', 'distance', 'address', 'latitude', 'longitude', 'description', 'image_url'];
  const updates = {};
  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(request.body || {}, field)) updates[field] = request.body[field];
  }
  if (!Object.keys(updates).length) return response.status(400).json({ error: 'Provide at least one destination field to update.' });
  if (Object.prototype.hasOwnProperty.call(updates, 'name')
    && (typeof updates.name !== 'string' || !updates.name.trim() || updates.name.length > 120)) {
    return response.status(400).json({ error: 'Enter a destination name up to 120 characters.' });
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'category')
    && (typeof updates.category !== 'string' || !updates.category.trim() || updates.category.length > 80)) {
    return response.status(400).json({ error: 'Enter a category up to 80 characters.' });
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'distance')
    && (typeof updates.distance !== 'string' || updates.distance.length > 40)) {
    return response.status(400).json({ error: 'Distance must be a text value up to 40 characters.' });
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'address')
    && updates.address !== null && (typeof updates.address !== 'string' || updates.address.length > 240)) {
    return response.status(400).json({ error: 'Address must be a text value up to 240 characters.' });
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'description')
    && (typeof updates.description !== 'string' || updates.description.length > 2000)) {
    return response.status(400).json({ error: 'Description must be a text value up to 2000 characters.' });
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'image_url') && updates.image_url !== null && updates.image_url !== '') {
    try {
      const parsed = new URL(updates.image_url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid URL');
    } catch (_error) {
      return response.status(400).json({ error: 'Image URL must be a valid http or https URL.' });
    }
  }

  const hasLatitude = Object.prototype.hasOwnProperty.call(updates, 'latitude');
  const hasLongitude = Object.prototype.hasOwnProperty.call(updates, 'longitude');
  if (hasLatitude !== hasLongitude) {
    return response.status(400).json({ error: 'Choose both latitude and longitude for the destination.' });
  }
  if (hasLatitude) {
    const latitude = Number(updates.latitude);
    const longitude = Number(updates.longitude);
    if (!insideKalibo(latitude, longitude)) {
      return response.status(400).json({ error: 'The location must be inside Kalibo, Aklan.' });
    }
    updates.latitude = latitude;
    updates.longitude = longitude;
  }
  if (typeof updates.name === 'string') updates.name = updates.name.trim();
  if (typeof updates.category === 'string') updates.category = updates.category.trim();
  if (typeof updates.distance === 'string') updates.distance = updates.distance.trim();
  if (typeof updates.address === 'string') updates.address = updates.address.trim() || null;
  if (typeof updates.description === 'string') updates.description = updates.description.trim();
  if (updates.image_url === '') updates.image_url = null;

  const { data, error } = await supabase
    .from('destinations')
    .update(updates)
    .eq('id', request.params.placeId)
    .select('id, name, category, distance, address, latitude, longitude, description, image_url, rating, reviews, created_at')
    .maybeSingle();
  if (error) return response.status(500).json({ error: 'Could not update this destination.' });
  if (!data) return response.status(404).json({ error: 'Destination not found.' });
  return response.json({ place: data });
});

app.delete('/api/admin/places/:placeId', requireAdmin, async (request, response) => {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(request.params.placeId)) {
    return response.status(400).json({ error: 'Destination ID is invalid.' });
  }
  const { data, error } = await supabase
    .from('destinations')
    .delete()
    .eq('id', request.params.placeId)
    .select('id')
    .maybeSingle();
  if (error) return response.status(500).json({ error: 'Could not delete this destination.' });
  if (!data) return response.status(404).json({ error: 'Destination not found.' });
  return response.json({ ok: true });
});

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Kaliventure API listening on port ${PORT}`);
});
