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

// Volatilidade por ativo: thresholds mais altos para moedas mais voláteis
var VOL_MULT = {
  bitcoin: 1.0, ethereum: 1.1, solana: 1.4, binancecoin: 1.2,
  ripple: 1.3, cardano: 1.4, dogecoin: 1.8, 'avalanche-2': 1.5,
  sui: 1.6, chainlink: 1.4, pepe: 2.0
};

// RSI simplificado para background (Wilder smoothing)
function bgCalcRSI(prices, period) {
  if (!prices || prices.length < period + 1) return null;
  var data = prices.slice(-(period * 3));
  if (data.length < period + 1) return null;
  var avgGain = 0, avgLoss = 0;
  for (var i = 1; i <= period; i++) {
    var diff = data[i] - data[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period; avgLoss /= period;
  for (var j = period + 1; j < data.length; j++) {
    var d = data[j] - data[j - 1];
    if (d > 0) { avgGain = (avgGain * (period - 1) + d) / period; avgLoss = (avgLoss * (period - 1)) / period; }
    else { avgGain = (avgGain * (period - 1)) / period; avgLoss = (avgLoss * (period - 1) - d) / period; }
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

// Bollinger %B simplificado para background
function bgCalcBollingerB(prices) {
  if (!prices || prices.length < 20) return null;
  var data = prices.slice(-20);
  var mean = 0; for (var i = 0; i < data.length; i++) mean += data[i]; mean /= data.length;
  var variance = 0; for (var j = 0; j < data.length; j++) variance += (data[j] - mean) * (data[j] - mean); variance /= data.length;
  var stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0.5;
  var upper = mean + 2 * stdDev, lower = mean - 2 * stdDev;
  return (prices[prices.length - 1] - lower) / (upper - lower);
}

async function checkPricesInBackground() {
  try {
    // Busca com sparkline para RSI/Bollinger
    var ids = 'bitcoin,ethereum,solana,binancecoin,ripple,cardano,dogecoin,avalanche-2,sui,chainlink';
    var url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=brl&ids=' + ids + '&order=market_cap_desc&sparkline=true&price_change_percentage=1h,24h,7d';

    var response = await fetch(url);
    if (!response.ok) return;
    var coins = await response.json();

    // Fear & Greed
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
      var change7d = coin.price_change_percentage_7d_in_currency || 0;
      var price = coin.current_price;
      var athChange = coin.ath_change_percentage || 0;
      var sparkline = (coin.sparkline_in_7d && coin.sparkline_in_7d.price) || [];
      var mult = VOL_MULT[coin.id] || 1.3;

      // ===== SCORE DE COMPRA =====
      var buyScore = 0;
      var buySignals = 0; // confluência

      // Queda 24h (threshold ajustado por volatilidade)
      if (change24h <= -(4 * mult)) {
        buyScore += Math.min(25, 8 + (Math.abs(change24h) - 4 * mult) * 2);
        buySignals++;
      }
      // Queda 1h
      if (change1h < -(2 * mult)) { buyScore += Math.min(18, 8 + Math.abs(change1h) * 1.2); buySignals++; }

      // Perto da mínima
      if (coin.low_24h && price) {
        var dist = ((price - coin.low_24h) / coin.low_24h) * 100;
        if (dist < 1) { buyScore += 12; buySignals++; }
        else if (dist < 3) buyScore += 6;
      }

      // ATH
      if (athChange < -70) buyScore += 8;
      else if (athChange > -10) { buyScore -= 10; buySignals--; }

      // Volume na queda
      if (coin.total_volume && coin.market_cap && coin.market_cap > 0 && change24h < 0) {
        if (coin.total_volume / coin.market_cap > 0.15) { buyScore += 8; buySignals++; }
      }

      // RSI
      if (sparkline.length > 15) {
        var rsi = bgCalcRSI(sparkline, 14);
        if (rsi !== null) {
          if (rsi < 25) { buyScore += 12; buySignals++; }
          else if (rsi < 35) { buyScore += 7; buySignals++; }
          else if (rsi > 70) { buyScore -= 8; buySignals--; }
        }
      }

      // Bollinger
      if (sparkline.length >= 20) {
        var bb = bgCalcBollingerB(sparkline);
        if (bb !== null) {
          if (bb < 0) { buyScore += 10; buySignals++; }
          else if (bb < 0.1) { buyScore += 6; buySignals++; }
          else if (bb > 0.95) { buyScore -= 6; buySignals--; }
        }
      }

      // Fear & Greed
      if (fgVal <= 20) { buyScore += 10; buySignals++; }
      else if (fgVal <= 35) { buyScore += 5; }
      else if (fgVal >= 80) { buyScore -= 10; buySignals--; }
      else if (fgVal >= 65) { buyScore -= 4; }

      // Confluência: bônus quando múltiplos indicadores concordam
      if (buySignals >= 4) buyScore += 8;
      else if (buySignals >= 3) buyScore += 5;
      else if (buySignals <= -2) buyScore -= 6;

      buyScore = Math.max(0, Math.min(95, buyScore));

      // Só notifica se ≥65% (sinal realmente forte)
      if (buyScore >= 65) {
        var priceStr = price >= 1000
          ? 'R$ ' + price.toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2})
          : 'R$ ' + price.toFixed(2);
        var buyReasons = [];
        if (change24h <= -5) buyReasons.push('queda de ' + Math.abs(change24h).toFixed(1) + '%');
        if (rsi !== null && rsi < 30) buyReasons.push('RSI ' + Math.round(rsi));
        if (bb !== null && bb < 0.1) buyReasons.push('Bollinger sobrevendido');
        if (fgVal <= 30) buyReasons.push('Fear ' + fgVal);
        alerts.push({
          title: '🚨 COMPRA ' + sym + ' (' + buyScore + '%) — ' + buySignals + ' indicadores',
          body: sym + ' a ' + priceStr + ' — ' + (buyReasons.join(', ') || 'múltiplos sinais convergentes') + '. Abra o Radar.',
          tag: 'bg-buy-' + coin.id + '-' + new Date().toISOString().slice(0, 13)
        });
      }

      // ===== SCORE DE VENDA =====
      var sellScore = 0;
      var sellSignals = 0;

      if (change24h >= (5 * mult)) { sellScore += Math.min(25, 8 + (change24h - 5 * mult) * 2); sellSignals++; }
      if (change1h > 3 * mult) { sellScore += Math.min(18, 8 + change1h * 1.2); sellSignals++; }

      // Perto da máxima
      if (coin.high_24h && price) {
        var distH = ((coin.high_24h - price) / coin.high_24h) * 100;
        if (distH < 1) { sellScore += 12; sellSignals++; }
        else if (distH < 3) sellScore += 6;
      }

      // ATH
      if (athChange > -2) { sellScore += 15; sellSignals++; }
      else if (athChange > -5) { sellScore += 10; sellSignals++; }

      // RSI sobrecomprado
      if (sparkline.length > 15) {
        var rsiS = bgCalcRSI(sparkline, 14);
        if (rsiS !== null) {
          if (rsiS > 80) { sellScore += 12; sellSignals++; }
          else if (rsiS > 70) { sellScore += 6; sellSignals++; }
          else if (rsiS < 30) { sellScore -= 8; sellSignals--; }
        }
      }

      // Bollinger
      if (sparkline.length >= 20) {
        var bbS = bgCalcBollingerB(sparkline);
        if (bbS !== null) {
          if (bbS > 1) { sellScore += 10; sellSignals++; }
          else if (bbS > 0.9) { sellScore += 6; sellSignals++; }
          else if (bbS < 0.1) { sellScore -= 6; sellSignals--; }
        }
      }

      // Fear & Greed
      if (fgVal >= 80) { sellScore += 8; sellSignals++; }
      else if (fgVal >= 65) sellScore += 4;
      else if (fgVal <= 20) { sellScore -= 8; sellSignals--; }

      // Confluência
      if (sellSignals >= 4) sellScore += 8;
      else if (sellSignals >= 3) sellScore += 5;

      sellScore = Math.max(0, Math.min(95, sellScore));

      if (sellScore >= 65) {
        alerts.push({
          title: '🔴 VENDA ' + sym + ' (' + sellScore + '%) — ' + sellSignals + ' indicadores',
          body: sym + ' subiu ' + change24h.toFixed(1) + '% — ' + sellSignals + ' indicadores confirmam. Abra o Radar.',
          tag: 'bg-sell-' + coin.id + '-' + new Date().toISOString().slice(0, 13)
        });
      }
    }

    // Máximo 3 notificações, priorizando os scores mais altos
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
