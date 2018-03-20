var _ = require('lodash');
var fs = require('fs');
var util = require('../../core/util');
var config = util.getConfig();
var dirs = util.dirs();
var log = require(dirs.core + 'log');

var ENV = util.gekkoEnv();
var mode = util.gekkoMode();
var startTime = util.getStartTime();

var talib = require(dirs.core + 'talib');
if(talib == null) {
  log.warn('TALIB indicators could not be loaded, they will be unavailable.');
}

var tulind = require(dirs.core + 'tulind');
if(tulind == null) {
  log.warn('TULIP indicators could not be loaded, they will be unavailable.');
}

var indicatorsPath = dirs.methods + 'indicators/';
var indicatorFiles = fs.readdirSync(indicatorsPath);
var Indicators = {};

_.each(indicatorFiles, function(indicator) {
  const indicatorName = indicator.split(".")[0];
  if (indicatorName[0] != "_")
    try {
      Indicators[indicatorName] = require(indicatorsPath + indicator);
    } catch (e) {
      log.error("Failed to load indicator", indicatorName);
    }
});

var allowedIndicators = _.keys(Indicators);
var allowedTalibIndicators = _.keys(talib);
var allowedTulipIndicators = _.keys(tulind);

var Base = function(settings) {
  _.bindAll(this);

  // properties
  this.age = 0;
  this.processedTicks = 0;
  this.setup = false;
  this.settings = settings;
  this.tradingAdvisor = config.tradingAdvisor;
  // defaults
  this.requiredHistory = 0;
  this.priceValue = 'close';
  this.indicators = {};
  this.talibIndicators = {};
  this.tulipIndicators = {};
  this.asyncTick = false;
  this.candlePropsCacheSize = 1000;
  this.deferredTicks = [];

  this.completedWarmup = false;

  this._prevAdvice;

  this.candleProps = {
    open: [],
    high: [],
    low: [],
    close: [],
    volume: [],
    vwp: [],
    trades: []
  };

  // make sure we have all methods
  _.each(['init', 'check'], function(fn) {
    if(!this[fn])
      util.die('No ' + fn + ' function in this trading method found.')
  }, this);

  if(!this.update)
    this.update = function() {};

  if(!this.end)
    this.end = function() {};

  // let's run the implemented starting point
  this.init();

  if(!config.debug || !this.log)
    this.log = function() {};

  this.setup = true;

  if(_.size(this.talibIndicators) || _.size(this.tulipIndicators))
    this.asyncTick = true;

  if(_.size(this.indicators))
    this.hasSyncIndicators = true;
}

// teach our base trading method events
util.makeEventEmitter(Base);


Base.prototype.tick = function(candle, done) {

  if(
    this.asyncTick &&
    this.hasSyncIndicators &&
    this.age !== this.processedTicks
  ) {
    // Gekko will call talib and run strat
    // functions when talib is done, but by
    // this time the sync indicators might be
    // updated with future candles.
    //
    // See @link: https://github.com/askmike/gekko/issues/837#issuecomment-316549691
    this.deferredTicks.push(candle);
    return done();
  }

  this.age++;

  if(this.asyncTick) {
    this.candleProps.open.push(candle.open);
    this.candleProps.high.push(candle.high);
    this.candleProps.low.push(candle.low);
    this.candleProps.close.push(candle.close);
    this.candleProps.volume.push(candle.volume);
    this.candleProps.vwp.push(candle.vwp);
    this.candleProps.trades.push(candle.trades);

    if(this.age > this.candlePropsCacheSize) {
      this.candleProps.open.shift();
      this.candleProps.high.shift();
      this.candleProps.low.shift();
      this.candleProps.close.shift();
      this.candleProps.volume.shift();
      this.candleProps.vwp.shift();
      this.candleProps.trades.shift();
    }
  }

  // update all indicators
  var price = candle[this.priceValue];
  _.each(this.indicators, function(i) {
    if(i.input === 'price')
      i.update(price);
    if(i.input === 'candle')
      i.update(candle);
  },this);

  // update the trading method
  if(!this.asyncTick) {
    this.propogateTick(candle);

    return done();
  }

  this.tickDone = done;

  var next = _.after(
    _.size(this.talibIndicators) + _.size(this.tulipIndicators),
    () => {
      this.propogateTick(candle);
      this.tickDone();
    }
  );

  var basectx = this;

  // handle result from talib
  var talibResultHander = function(err, result) {
    if(err)
      util.die('TALIB ERROR:', err);

    // fn is bound to indicator
    this.result = _.mapValues(result, v => _.last(v));
    next(candle);
  }

  // handle result from talib
  _.each(
    this.talibIndicators,
    indicator => indicator.run(
      basectx.candleProps,
      talibResultHander.bind(indicator)
    )
  );

  // handle result from tulip
  var tulindResultHander = function(err, result) {
    if(err)
      util.die('TULIP ERROR:', err);

    // fn is bound to indicator
    this.result = _.mapValues(result, v => _.last(v));
    next(candle);
  }

  // handle result from tulip indicators
  _.each(
    this.tulipIndicators,
    indicator => indicator.run(
      basectx.candleProps,
      tulindResultHander.bind(indicator)
    )
  );
}

Base.prototype.propogateTick = function(candle) {
  this.candle = candle;
  this.update(candle);

  this.processedTicks++;
  var isAllowedToCheck = this.requiredHistory <= this.age;

  if(!this.completedWarmup) {

    // in live mode we might receive more candles
    // than minimally needed. In that case check
    // whether candle start time is > startTime
    var isPremature = false;

    if(mode === 'realtime'){
      const startTimeMinusCandleSize = startTime
        .clone()
        .subtract(this.tradingAdvisor.candleSize, "minutes");

      isPremature = candle.start < startTimeMinusCandleSize;
    }

    if(isAllowedToCheck && !isPremature) {
      this.completedWarmup = true;
      this.emit(
        'stratWarmupCompleted',
        {start: candle.start.clone()}
      );
    }
  }

  if(this.completedWarmup) {
    this.log(candle);
    this.check(candle);

    if(
      this.asyncTick &&
      this.hasSyncIndicators &&
      this.deferredTicks.length
    ) {
      return this.tick(this.deferredTicks.shift())
    }
  }

  const indicators = {};
  _.each(this.indicators, (indicator, name) => {
    indicators[name] = indicator.result;
  });

  this.emit('stratUpdate', {
    date: candle.start,
    indicators
  });

  // are we totally finished?
  var done = this.age === this.processedTicks;
  if(done && this.finishCb)
    this.finishCb();
}

Base.prototype.addTalibIndicator = function(name, type, parameters) {
  if(!talib)
    util.die('Talib is not enabled');

  if(!_.contains(allowedTalibIndicators, type))
    util.die('I do not know the talib indicator ' + type);

  if(this.setup)
    util.die('Can only add talib indicators in the init method!');

  var basectx = this;

  this.talibIndicators[name] = {
    run: talib[type].create(parameters),
    result: NaN
  }
}

Base.prototype.addTulipIndicator = function(name, type, parameters) {
  if(!tulind)
  util.die('Tulip indicators is not enabled');

  if(!_.contains(allowedTulipIndicators, type))
    util.die('I do not know the tulip indicator ' + type);

  if(this.setup)
    util.die('Can only add tulip indicators in the init method!');

  var basectx = this;

  this.tulipIndicators[name] = {
    run: tulind[type].create(parameters),
    result: NaN
  }
}

Base.prototype.addIndicator = function(name, type, parameters) {
  if(!_.contains(allowedIndicators, type))
    util.die('I do not know the indicator ' + type);

  if(this.setup)
    util.die('Can only add indicators in the init method!');

  this.indicators[name] = new Indicators[type](parameters);

  // some indicators need a price stream, others need full candles
}

Base.prototype.advice = function(newPosition) {
  // ignore legacy soft advice
  if(!newPosition)
    return;

  // ignore if advice equals previous advice
  if(newPosition === this._prevAdvice)
    return;

  this._prevAdvice = newPosition;

  console.log('emitting advice', newPosition);

  this.emit('advice', {
    recommendation: newPosition
  });
}

// Because the trading method might be async we need
// to be sure we only stop after all candles are
// processed.
Base.prototype.finish = function(done) {
  if(!this.asyncTick) {
    this.end();
    return done();
  }

  if(this.age === this.processedTicks) {
    this.end();
    return done();
  }

  // we are not done, register cb
  // and call after we are..
  this.finishCb = done;
}

module.exports = Base;
