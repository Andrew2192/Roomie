import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { WebView } from 'react-native-webview';

// Public server address only. Never put Snowflake tokens in Expo public variables.
// IMPORTANT: localhost on the iPhone is NOT your Mac.
const API_URL = (process.env.EXPO_PUBLIC_API_URL || '').replace(/\/$/, '');
const VIEWER_URL = (process.env.EXPO_PUBLIC_3D_VIEWER_URL || '').trim();

const COLORS = {
  background: '#07121B',
  surface: '#101F2C',
  surface2: '#172A38',
  border: '#254051',
  text: '#F0F8FC',
  muted: '#91A9B9',
  mint: '#81E4CE',
  mintDark: '#16483F',
  violet: '#BAABFF',
  warning: '#FFD39B',
};

const DEMO_RESPONSE = {
  summary: 'Example: A compact room with a desk, chair, and bed.',
  observations: [
    'Example: Small accessories may be occupying the desk surface.',
    'Example: Under-bed storage could help free up floor space.',
  ],
  suggestions: [
    { title: 'Clear your workspace', reason: 'Move less-used accessories off the desk.', priority: 'high' },
    { title: 'Use hidden storage', reason: 'Try shallow bins under the bed.', priority: 'medium' },
    { title: 'Keep walking paths clear', reason: 'Move loose items into one organized zone.', priority: 'low' },
  ],
};

function Chip({ children, color = COLORS.mint }) {
  return (
    <View style={[styles.chip, { borderColor: color + '55' }]}>
      <Text style={[styles.chipText, { color }]}>{children}</Text>
    </View>
  );
}

function ActionButton({ title, onPress, secondary = false, disabled = false, style }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        secondary ? styles.actionSecondary : styles.actionPrimary,
        disabled && { opacity: 0.5 },
        pressed && { opacity: 0.75 },
        style,
      ]}
    >
      <Text style={[styles.actionText, secondary && { color: COLORS.text }]}>{title}</Text>
    </Pressable>
  );
}

function SectionTitle({ eyebrow, title, subtitle }) {
  return (
    <View style={{ marginBottom: 17 }}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={styles.sectionTitle}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

function ViewerPanel({ photo }) {
  const viewerRef = useRef(null);
  const [isReady, setIsReady] = useState(false);
  const photoDataUrl = photo ? `data:image/jpeg;base64,${photo.base64}` : null;

  const sendPhoto = useCallback(() => {
    if (!photoDataUrl || !viewerRef.current) return;
    // Person 2's web viewer listens for the same ROOMIE_IMAGE message.
    const script = `window.dispatchEvent(new MessageEvent('message', {data: {type: 'ROOMIE_IMAGE', imageDataUrl: ${JSON.stringify(photoDataUrl)}}})); true;`;
    viewerRef.current.injectJavaScript(script);
  }, [photoDataUrl]);

  if (!photo) {
    return (
      <View style={styles.empty3d}>
        <Text style={styles.bigSymbol}>◇</Text>
        <Text style={styles.emptyTitle}>Nothing to explore yet</Text>
        <Text style={styles.emptyBody}>Scan or upload your room first.</Text>
      </View>
    );
  }
  if (!VIEWER_URL) {
    return (
      <View style={styles.empty3d}>
        <Text style={styles.bigSymbol}>▧</Text>
        <Text style={styles.emptyTitle}>3D viewer integration pending</Text>
        <Text style={styles.emptyBody}>
          Person 2 can connect their Three.js page using EXPO_PUBLIC_3D_VIEWER_URL.\nThis is not a reconstructed 3D scan yet.
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.viewerOuter}>
      <WebView
        ref={viewerRef}
        key={VIEWER_URL}
        source={{ uri: VIEWER_URL }}
        style={{ flex: 1, backgroundColor: COLORS.background }}
        originWhitelist={['*']}
        javaScriptEnabled
        onLoadEnd={() => { setIsReady(true); sendPhoto(); }}
        onError={(event) => Alert.alert('3D viewer unavailable', event.nativeEvent.description || 'Check the viewer URL.')}
      />
      {isReady ? null : <View style={styles.viewerLoading}><ActivityIndicator color={COLORS.mint} /></View>}
      {/* After switching photos, this component remounts in App through the photo URI key. */}
    </View>
  );
}

export default function App() {
  const [tab, setTab] = useState('scan');
  const [photo, setPhoto] = useState(null);
  const [status, setStatus] = useState('idle');
  const [insights, setInsights] = useState(null);
  const [isDemo, setIsDemo] = useState(false);
  const [error, setError] = useState('');

  async function onImageChosen(result) {
    if (result.canceled || !result.assets?.length) return;
    try {
      const asset = result.assets[0];
      // Normalize HEIC/large photos to small JPEGs suitable for Snowflake and WebView.
      const ctx = ImageManipulator.ImageManipulator.manipulate(asset.uri, { maxWidth: 1600, maxHeight: 1600 });
      ctx.resize({ width: 960, height: null });
      const rendered = await ctx.renderAsync();
      const normalized = await rendered.saveAsync({ format: ImageManipulator.SaveFormat.JPEG, compress: 0.72, base64: true });
      if (!normalized.base64) throw new Error('Could not prepare this photo.');
      setPhoto({ uri: normalized.uri, base64: normalized.base64 });
      setInsights(null);
      setIsDemo(false);
      setError('');
      setStatus('idle');
      setTab('scan');
    } catch (e) {
      Alert.alert('Could not open photo', e.message || 'Try a different photo.');
    }
  }

  async function capturePhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Camera permission needed', 'Allow Roomie to access the camera in your phone settings.');
      return;
    }
    try {
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.85 });
      await onImageChosen(result);
    } catch (e) { Alert.alert('Camera error', e.message || 'Please try again.'); }
  }

  async function pickPhoto() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85 });
      await onImageChosen(result);
    } catch (e) { Alert.alert('Photo library error', e.message || 'Please try again.'); }
  }

  async function analyzeRoom() {
    if (!photo || status === 'loading') return;
    setError('');
    if (!API_URL) {
      setInsights(DEMO_RESPONSE);
      setIsDemo(true);
      setStatus('done');
      setTab('insights');
      return;
    }
    setStatus('loading');
    try {
      const payload = new FormData();
      payload.append('image', { uri: photo.uri, name: 'room.jpg', type: 'image/jpeg' });
      const response = await fetch(`${API_URL}/api/analyze`, { method: 'POST', body: payload });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Server error ${response.status}`);
      if (!data || typeof data.summary !== 'string' || !Array.isArray(data.observations) || !Array.isArray(data.suggestions)) {
        throw new Error('The server response is missing summary, observations, or suggestions.');
      }
      setInsights(data);
      setIsDemo(false);
      setStatus('done');
      setTab('insights');
    } catch (e) {
      setError(e.message || 'Cannot reach the analysis server.');
      setStatus('error');
    }
  }

  function showDemo() {
    setInsights(DEMO_RESPONSE);
    setIsDemo(true);
    setStatus('done');
    setTab('insights');
    setError('');
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />
      <View style={styles.header}>
        <View style={styles.headerLogo}><Text style={styles.headerLogoText}>⌗</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.brand}>roomie<Text style={{ color: COLORS.mint }}>.</Text></Text>
          <Text style={styles.brandCaption}>SPATIAL INTELLIGENCE</Text>
        </View>
        <Chip>HACKATHON MVP</Chip>
      </View>

      {tab === 'scan' && (
        <ScrollView contentContainerStyle={styles.scroll}>
          <SectionTitle eyebrow="01 / CAPTURE" title={photo ? 'Your room, ready.' : 'See your space differently.'}
            subtitle={photo ? 'Photo captured. Explore its 3D view or get practical suggestions.' : 'One photo is all it takes to start imagining a better space.'} />
          {photo ? (
            <View style={styles.photoCard}>
              <Image source={{ uri: photo.uri }} style={styles.photoPreview} resizeMode="cover" />
              <View style={styles.previewCaption}><Text style={styles.photoLabel}>YOUR ROOM PHOTO</Text><Chip>READY</Chip></View>
            </View>
          ) : (
            <View style={styles.heroCard}>
              <View style={styles.targetOuter}><Text style={styles.targetSymbol}>⌗</Text></View>
              <Text style={styles.heroHeadline}>Capture the possibilities.</Text>
              <Text style={styles.heroCaption}>Point your camera at your bedroom, dorm, or workspace.</Text>
              <View style={styles.scanLines}><Text style={styles.scanLinesText}>FRAME YOUR SPACE HERE</Text></View>
            </View>
          )}
          <ActionButton title={photo ? '↻  Scan another room' : '◉  Scan my room'} onPress={capturePhoto} />
          <ActionButton title="▧  Choose from photos" onPress={pickPhoto} secondary style={{ marginTop: 10 }} />
          {photo && (
            <>
              <ActionButton title={status === 'loading' ? 'Analyzing room…' : '✦  Analyze with Snowflake'} onPress={analyzeRoom} disabled={status === 'loading'} style={{ marginTop: 20 }} />
              {status === 'loading' && <ActivityIndicator color={COLORS.mint} style={{ marginTop: 18 }} />}
              {!API_URL && <Text style={styles.note}>PREVIEW MODE — Sample insights will be shown until the backend URL is configured.</Text>}
              {!!error && (
                <View style={styles.errorCard}>
                  <Text style={styles.errorText}>Couldn't analyze room: {error}</Text>
                  <ActionButton title="Show labeled example instead" onPress={showDemo} secondary style={{ marginTop: 10 }} />
                </View>
              )}
            </>
          )}
          <View style={styles.featureRow}>
            <View style={styles.feature}><Text style={styles.featureIcon}>◇</Text><Text style={styles.featureText}>3D perspective</Text></View>
            <View style={styles.feature}><Text style={styles.featureIcon}>✦</Text><Text style={styles.featureText}>AI room insights</Text></View>
            <View style={styles.feature}><Text style={styles.featureIcon}>⌑</Text><Text style={styles.featureText}>Smart ideas</Text></View>
          </View>
        </ScrollView>
      )}

      {tab === 'three' && (
        <ScrollView contentContainerStyle={styles.scroll}>
          <SectionTitle eyebrow="02 / EXPLORE" title="A new perspective." subtitle="Rotate and explore your room's estimated depth as a 3D scene." />
          <View style={styles.card}>
            <View style={styles.cardHeader}><Text style={styles.cardTitle}>◇  Spatial view</Text><Chip color={COLORS.violet}>3D</Chip></View>
            <ViewerPanel key={photo?.uri || 'empty'} photo={photo} />
          </View>
          <Text style={styles.note}>Single-image depth is approximate. Hidden surfaces and exact room measurements cannot be recovered.</Text>
          {!photo && <ActionButton title="Go scan a room" onPress={() => setTab('scan')} style={{ marginTop: 18 }} />}
        </ScrollView>
      )}

      {tab === 'insights' && (
        <ScrollView contentContainerStyle={styles.scroll}>
          <SectionTitle eyebrow="03 / IMPROVE" title="Make more room for life." subtitle="Suggestions based on visible objects in your photo." />
          {!insights ? (
            <View style={styles.emptyInsights}>
              <Text style={styles.bigSymbol}>✦</Text>
              <Text style={styles.emptyTitle}>No insights yet</Text>
              <Text style={styles.emptyBody}>Scan a room and choose Analyze to see recommendations.</Text>
              <ActionButton title="Scan a room" onPress={() => setTab('scan')} style={{ marginTop: 18 }} />
            </View>
          ) : (
            <>
              {isDemo && <View style={styles.demoBanner}><Text style={styles.demoText}>DEMO DATA — These are example suggestions, not a Snowflake analysis of your image.</Text></View>}
              <View style={styles.card}><Text style={styles.smallHeading}>ROOM SUMMARY</Text><Text style={styles.summary}>{insights.summary}</Text></View>
              <Text style={[styles.smallHeading, { marginTop: 23, marginBottom: 8 }]}>WHAT WE NOTICED</Text>
              {insights.observations.map((observation, index) => <View key={`${index}-${observation}`} style={styles.observation}><Text style={styles.bullet}>•</Text><Text style={styles.observationText}>{typeof observation === 'string' ? observation : String(observation?.text || '')}</Text></View>)}
              <Text style={[styles.smallHeading, { marginTop: 23, marginBottom: 10 }]}>YOUR IMPROVEMENT PLAN</Text>
              {insights.suggestions.map((s, i) => (
                <View key={`${i}-${s.title}`} style={styles.suggestion}>
                  <View style={styles.suggestionIndex}><Text style={styles.suggestionNumber}>{String(i + 1).padStart(2, '0')}</Text></View>
                  <View style={{ flex: 1 }}>
                    <View style={styles.suggestionTitleRow}><Text style={styles.suggestionTitle}>{s.title}</Text><Chip color={s.priority === 'high' ? COLORS.warning : COLORS.mint}>{(s.priority || 'idea').toUpperCase()}</Chip></View>
                    <Text style={styles.suggestionBody}>{s.reason}</Text>
                  </View>
                </View>
              ))}
              <ActionButton title="Scan another room" onPress={() => setTab('scan')} secondary style={{ marginTop: 8 }} />
            </>
          )}
        </ScrollView>
      )}

      <View style={styles.tabs}>
        {[['scan', '⌗', 'Scan'], ['three', '◇', '3D View'], ['insights', '✦', 'Insights']].map(([id, icon, title]) => (
          <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: tab === id }} onPress={() => setTab(id)} style={[styles.tab, tab === id && styles.activeTab]}>
            <Text style={[styles.tabIcon, { color: tab === id ? COLORS.mint : COLORS.muted }]}>{icon}</Text>
            <Text style={[styles.tabLabel, { color: tab === id ? COLORS.mint : COLORS.muted }]}>{title}</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.background },
  header: { height: 78, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  headerLogo: { width: 42, height: 42, backgroundColor: COLORS.mint, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  headerLogoText: { fontSize: 26, color: COLORS.background, fontWeight: '900' },
  brand: { color: COLORS.text, fontSize: 25, fontWeight: '800', letterSpacing: -1 },
  brandCaption: { color: COLORS.muted, fontSize: 8, letterSpacing: 2.1, fontWeight: '700' },
  chip: { borderWidth: 1, borderRadius: 7, paddingHorizontal: 9, paddingVertical: 5, backgroundColor: '#142A35' },
  chipText: { fontSize: 8, letterSpacing: 0.8, fontWeight: '800' },
  scroll: { padding: 20, paddingBottom: 45 },
  eyebrow: { color: COLORS.mint, fontWeight: '900', fontSize: 11, letterSpacing: 2.2, marginBottom: 9 },
  sectionTitle: { color: COLORS.text, fontSize: 30, fontWeight: '800', letterSpacing: -1.1, lineHeight: 36 },
  subtitle: { color: COLORS.muted, fontSize: 14, lineHeight: 21, marginTop: 9 },
  heroCard: { minHeight: 250, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border, borderRadius: 24, marginTop: 10, marginBottom: 18, padding: 22, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  targetOuter: { width: 82, height: 82, borderRadius: 24, borderWidth: 1, borderColor: '#2F7268', backgroundColor: COLORS.mintDark, alignItems: 'center', justifyContent: 'center' },
  targetSymbol: { color: COLORS.mint, fontSize: 50, fontWeight: '300' },
  heroHeadline: { color: COLORS.text, fontWeight: '800', fontSize: 20, marginTop: 18 },
  heroCaption: { textAlign: 'center', color: COLORS.muted, fontSize: 12, marginTop: 7, lineHeight: 19 },
  scanLines: { marginTop: 20, borderTopWidth: 1, borderColor: '#315262', paddingTop: 12, width: '100%' },
  scanLinesText: { color: '#6A9FA2', textAlign: 'center', fontWeight: '700', fontSize: 9, letterSpacing: 2 },
  action: { minHeight: 54, paddingHorizontal: 18, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  actionPrimary: { backgroundColor: COLORS.mint },
  actionSecondary: { backgroundColor: COLORS.surface2, borderWidth: 1, borderColor: COLORS.border },
  actionText: { fontSize: 15, fontWeight: '800', color: COLORS.background },
  photoCard: { backgroundColor: COLORS.surface, borderColor: COLORS.border, borderWidth: 1, borderRadius: 19, marginTop: 7, marginBottom: 17, overflow: 'hidden' },
  photoPreview: { width: '100%', height: 280 },
  previewCaption: { padding: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  photoLabel: { color: COLORS.muted, fontSize: 10, letterSpacing: 1.3, fontWeight: '700' },
  featureRow: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 34 },
  feature: { alignItems: 'center', width: '31%' },
  featureIcon: { color: COLORS.mint, fontSize: 27 },
  featureText: { marginTop: 6, fontSize: 10, textAlign: 'center', color: COLORS.muted },
  note: { color: COLORS.muted, fontSize: 11, lineHeight: 17, marginTop: 13 },
  card: { backgroundColor: COLORS.surface, borderColor: COLORS.border, borderWidth: 1, borderRadius: 19, overflow: 'hidden', padding: 15 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 13 },
  cardTitle: { color: COLORS.text, fontWeight: '800', fontSize: 15 },
  viewerOuter: { height: 360, borderRadius: 13, overflow: 'hidden', borderColor: COLORS.border, borderWidth: 1, backgroundColor: COLORS.background },
  viewerLoading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.background },
  empty3d: { backgroundColor: '#0A1825', height: 360, borderRadius: 13, borderWidth: 1, borderColor: COLORS.border, alignItems: 'center', justifyContent: 'center', padding: 22 },
  bigSymbol: { color: COLORS.violet, fontSize: 58, marginBottom: 8 },
  emptyTitle: { color: COLORS.text, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  emptyBody: { color: COLORS.muted, lineHeight: 20, fontSize: 12, textAlign: 'center', marginTop: 8 },
  emptyInsights: { backgroundColor: COLORS.surface, borderColor: COLORS.border, borderWidth: 1, borderRadius: 18, padding: 25, alignItems: 'center' },
  smallHeading: { color: COLORS.mint, fontSize: 10, letterSpacing: 1.8, fontWeight: '900', marginBottom: 10 },
  summary: { color: COLORS.text, fontSize: 16, lineHeight: 24, fontWeight: '500' },
  observation: { flexDirection: 'row', paddingVertical: 13, paddingHorizontal: 13, backgroundColor: COLORS.surface, borderRadius: 11, marginBottom: 7 },
  bullet: { color: COLORS.mint, fontSize: 20, marginRight: 13, lineHeight: 20 },
  observationText: { flex: 1, color: COLORS.text, fontSize: 13, lineHeight: 19 },
  suggestion: { backgroundColor: COLORS.surface, borderColor: COLORS.border, borderWidth: 1, borderRadius: 15, padding: 15, marginBottom: 10, flexDirection: 'row', gap: 12 },
  suggestionIndex: { width: 31, height: 31, borderRadius: 10, backgroundColor: COLORS.mintDark, alignItems: 'center', justifyContent: 'center' },
  suggestionNumber: { color: COLORS.mint, fontSize: 12, fontWeight: '800' },
  suggestionTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 7, marginBottom: 7 },
  suggestionTitle: { color: COLORS.text, fontSize: 14, fontWeight: '800', flexShrink: 1 },
  suggestionBody: { color: COLORS.muted, fontSize: 12, lineHeight: 18 },
  demoBanner: { backgroundColor: '#382A1C', borderWidth: 1, borderColor: '#71552E', borderRadius: 11, padding: 12, marginBottom: 16 },
  demoText: { color: COLORS.warning, fontSize: 11, fontWeight: '700', lineHeight: 17 },
  errorCard: { backgroundColor: '#35252B', borderRadius: 12, padding: 14, marginTop: 14 },
  errorText: { color: '#FFBAC5', fontSize: 12, lineHeight: 18 },
  tabs: { flexDirection: 'row', paddingTop: 9, paddingBottom: Platform.OS === 'ios' ? 8 : 7, borderTopWidth: 1, borderTopColor: COLORS.border, backgroundColor: '#0C1A27' },
  tab: { flex: 1, alignItems: 'center', borderTopColor: 'transparent', borderTopWidth: 2, paddingTop: 4, paddingBottom: 5 },
  activeTab: { borderTopColor: COLORS.mint },
  tabIcon: { fontSize: 23 },
  tabLabel: { fontSize: 11, fontWeight: '800', marginTop: 3 },
});
