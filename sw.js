const CACHE_NAME = 'radar-v2';
const SHELL_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Instala: guarda o shell no cache
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(SHELL_URLS);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// Ativa: limpa caches antigos
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(n) { return n !== CACHE_NAME; })
             .map(function(n) { return caches.delete(n); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// Fetch: network-first, fallback to cache
self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request).then(function(response) {
      if (response.ok) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, clone);
        });
      }
      return response;
    }).catch(function() {
      return caches.match(event.request);
    })
  );
});

// ===== BACKGROUND PRICE CHECK =====
// Periodic Background Sync: Chrome Android acorda o SW periodicamente
// pra checar preços mesmo com o app fechado.
// Limitação: o navegador decide quando acordar (pode ser 1x por hora ou menos).

self.addEventListener('periodicsync', function(event) {
  if (event.tag === 'check-prices') {
    event.waitUntil(checkPricesInBackground());
  }
});

async function checkPricesInBackground() {
  try {
    // Busca os top 10 criptos
    var ids = 'bitcoin,ethereum,solana,binancecoin,ripple,cardano,dogecoin,avalanche-2,sui,chainlink';
    var url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=brl&ids=' + ids + '&order=market_cap_desc&sparkline=false&price_change_percentage=1h,24h,7d';

    var response = await fetch(url);
    if (!response.ok) return;
    var coins = await response.json();

    // Busca Fear & Greed
    var fgVal = 50;
    try {
      var fgResp = await fetch('https://api.alternative.me/fng/?limit=1');
      var fgData = await fgResp.json();
      if (fgData && fgData.data && fgData.data[0]) fgVal = parseInt(fgData.data[0].value);
    } catch(e) {}

    var alerts = [];

    for (var i = 0; i < coins.length; i++) {
      var coin = coins[i];
      var sym = coin.symbol.toUpperCase();
      var change24h = coin.price_change_percentage_24h_in_currency || 0;
      var change1h = coin.price_change_percentage_1h_in_currency || 0;
      var price = coin.current_price;
      var athChange = coin.ath_change_percentage || 0;

      // Score simplificado para background
      var score = 0;

      // Queda forte
      if (change24h <= -5) score += Math.min(30, 10 + Math.abs(change24h) * 2);
      if (change1h < -3) score += Math.min(20, 10 + Math.abs(change1h) * 2);

      // Perto da mínima
      if (coin.low_24h && price) {
        var dist = ((price - coin.low_24h) / coin.low_24h) * 100;
        if (dist < 1) score += 15;
        else if (dist < 3) score += 8;
      }

      // ATH distance
      if (athChange < -70) score += 8;
      else if (athChange > -5) score -= 10;

      // Fear & Greed
      if (fgVal <= 25) score += 10;
      else if (fgVal >= 75) score -= 8;

      // Volume
      if (coin.total_volume && coin.market_cap && coin.market_cap > 0) {
        if (coin.total_volume / coin.market_cap > 0.12) score += 8;
      }

      score = Math.max(0, Math.min(95, score));

      // Sinal de COMPRA forte (≥65%)
      if (score >= 65) {
        var priceStr = price >= 1000
          ? 'R$ ' + price.toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2})
          : 'R$ ' + price.toFixed(2);
        alerts.push({
          title: '🚨 COMPRA ' + sym + ' (' + score + '%)',
          body: sym + ' a ' + priceStr + ' — queda de ' + Math.abs(change24h).toFixed(1) + '% em 24h. Abra o Radar pra ver detalhes.',
          tag: 'bg-buy-' + coin.id + '-' + new Date().toISOString().slice(0, 13)
        });
      }

      // Sinal de VENDA forte
      if (change24h >= 8 || (athChange > -3 && change24h >= 3)) {
        var sellScore = 0;
        if (change24h >= 8) sellScore += 25;
        if (change1h > 3) sellScore += 15;
        if (athChange > -3) sellScore += 20;
        if (fgVal >= 75) sellScore += 10;
        sellScore = Math.min(95, sellScore);

        if (sellScore >= 60) {
          alerts.push({
            title: '🔴 VENDA ' + sym + ' (' + sellScore + '%)',
            body: sym + ' subiu ' + change24h.toFixed(1) + '% — pode ser hora de realizar. Abra o Radar.',
            tag: 'bg-sell-' + coin.id + '-' + new Date().toISOString().slice(0, 13)
          });
        }
      }
    }

    // Manda no máximo 3 notificações pra não inundar
    alerts.sort(function(a, b) { return parseInt(b.title.match(/\d+/)) - parseInt(a.title.match(/\d+/)); });
    for (var j = 0; j < Math.min(3, alerts.length); j++) {
      await self.registration.showNotification(alerts[j].title, {
        body: alerts[j].body,
        tag: alerts[j].tag,
        icon: './icon-192.png',
        badge: './icon-192.png',
        requireInteraction: true,
        silent: false
      });
    }
  } catch (e) {
    // Silently fail — background sync will retry
  }
}

// Notificação: foca na aba do radar ao clicar
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('./');
    })
  );
});
