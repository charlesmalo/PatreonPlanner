import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { useSession } from './api/hooks';
import { Layout } from './components/Layout';
import { CreatorBoard } from './routes/CreatorBoard';
import { LandingPage } from './routes/LandingPage';
import { ReviewQueue } from './routes/ReviewQueue';

export default function App() {
  const { user, loading, signOut } = useSession();

  return (
    <BrowserRouter>
      <Layout user={user} loadingSession={loading} onSignOut={signOut}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/c/:slug" element={<CreatorBoard />} />
          <Route path="/c/:slug/review" element={<ReviewQueue />} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
