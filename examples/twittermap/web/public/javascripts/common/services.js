angular.module('cloudberry.common', ['cloudberry.mapresultcache'])
  .factory('cloudberryConfig', function(){
    return {
      ws: config.wsURL,
      sentimentEnabled: config.sentimentEnabled,
      sentimentUDF: config.sentimentUDF,
      removeSearchBar: config.removeSearchBar,
      predefinedKeywords: config.predefinedKeywords,
      normalizationUpscaleFactor: 1000 * 1000,
      normalizationUpscaleText: "/M",
      sentimentUpperBound: 4,
      cacheThreshold: config.cacheThreshold,
      querySlicingMills: config.querySlicingMills,
      getPopulationTarget: function(parameters){
        switch (parameters.geoLevel) {
          case "state":
            return {
              joinKey: ["state"],
              dataset: "twitter.dsStatePopulation",
              lookupKey: ["stateID"],
              select: ["population"],
              as: ["population"]
            };
          case "county":
            return {
              joinKey: ["county"],
              dataset: "twitter.dsCountyPopulation",
              lookupKey: ["countyID"],
              select: ["population"],
              as: ["population"]
            };
          case "city":
            return {
              joinKey: ["city"],
              dataset: "twitter.dsCityPopulation",
              lookupKey: ["cityID"],
              select: ["population"],
              as: ["population"]
            };
        }
      }
    };
  })
  .service('cloudberry', function($timeout, cloudberryConfig, MapResultCache) {
    var startDate = config.startDate;
    var endDate = config.endDate;
    var defaultNonSamplingDayRange = 1500;
    var defaultSamplingDayRange = 1;
    var defaultSamplingSize = 10;
    var ws = new WebSocket(cloudberryConfig.ws);
    // The MapResultCache.getGeoIdsNotInCache() method returns the geoIds
    // not in the cache for the current query.
    var geoIdsNotInCache = [];

    var countRequest = JSON.stringify({
      dataset: "twitter.ds_tweet",
      global: {
        globalAggregate: {
          field: "*",
          apply: {
            name: "count"
          },
          as: "count"
        }},
      estimable : true,
      transform: {
        wrap: {
          key: "totalCount"
        }
      }
    });

    function requestLiveCounts() {
      if(ws.readyState === ws.OPEN){
        ws.send(countRequest);
      }
    }
    var myVar = setInterval(requestLiveCounts, 1000);

    function getLevel(level){
      switch(level){
        case "state" : return "stateID";
        case "county" : return "countyID";
        case "city" : return "cityID";
      }
    }

    function getFilter(parameters, maxDay, geoIds) {
      var spatialField = getLevel(parameters.geoLevel);
      var keywords = [];
      for(var i = 0; i < parameters.keywords.length; i++){
        keywords.push(parameters.keywords[i].replace("\"", "").trim());
      }
      var queryStartDate = new Date(parameters.timeInterval.end);
      queryStartDate.setDate(queryStartDate.getDate() - maxDay);
      queryStartDate = parameters.timeInterval.start > queryStartDate ? parameters.timeInterval.start : queryStartDate;

      var filter = [
        {
          field: "create_at",
          relation: "inRange",
          values: [queryStartDate.toISOString(), parameters.timeInterval.end.toISOString()]
        }, {
          field: "text",
          relation: "contains",
          values: keywords
        }
      ];
      if (geoIds.length <= 2000){
        filter.push(
          {
            field: "geo_tag." + spatialField,
            relation: "in",
            values: geoIds
          }
        );
      }
      return filter;
    }

    function byGeoRequest(parameters, geoIds) {
      if (cloudberryConfig.sentimentEnabled) {
        return {
          dataset: parameters.dataset,
          append: [{
            field: "text",
            definition: cloudberryConfig.sentimentUDF,
            type: "Number",
            as: "sentimentScore"
          }],
          filter: getFilter(parameters, defaultNonSamplingDayRange, geoIds),
          group: {
            by: [{
              field: "geo",
              apply: {
                name: "level",
                args: {
                  level: parameters.geoLevel
                }
              },
              as: parameters.geoLevel
            }],
            aggregate: [{
              field: "*",
              apply: {
                name: "count"
              },
              as: "count"
            }, {
              field: "sentimentScore",
              apply: {
                name: "sum"
              },
              as: "sentimentScoreSum"
            }, {
              field: "sentimentScore",
              apply: {
                name: "count"
              },
              as: "sentimentScoreCount"
            }],
            lookup: [
              cloudberryConfig.getPopulationTarget(parameters)
            ]
          }
        };
      } else {
        return {
          dataset: parameters.dataset,
          filter: getFilter(parameters, defaultNonSamplingDayRange, geoIds),
          group: {
            by: [{
              field: "geo",
              apply: {
                name: "level",
                args: {
                  level: parameters.geoLevel
                }
              },
              as: parameters.geoLevel
            }],
            aggregate: [{
              field: "*",
              apply: {
                name: "count"
              },
              as: "count"
            }],
            lookup: [
              cloudberryConfig.getPopulationTarget(parameters)
            ]
          }
        };
      }
    }

    function byTimeRequest(parameters) {
      return {
        dataset: parameters.dataset,
        filter: getFilter(parameters, defaultNonSamplingDayRange, parameters.geoIds),
        group: {
          by: [{
            field: "create_at",
            apply: {
              name: "interval",
              args: {
                unit: parameters.timeBin
              }
            },
            as: parameters.timeBin
          }],
          aggregate: [{
            field: "*",
            apply: {
              name: "count"
            },
            as: "count"
          }]
        }
      };
    }

    function byHashTagRequest(parameters) {
      return {
        dataset: parameters.dataset,
        filter: getFilter(parameters, defaultNonSamplingDayRange, parameters.geoIds),
        unnest: [{
          hashtags: "tag"
        }],
        group: {
          by: [{
            field: "tag"
          }],
          aggregate: [{
            field: "*",
            apply: {
              name: "count"
            },
            as: "count"
          }]
        },
        select: {
          order: ["-count"],
          limit: 50,
          offset: 0
        }
      };
    }

    var cloudberryService = {

      totalCount: 0,
      startDate: startDate,
      parameters: {
        dataset: "twitter.ds_tweet",
        keywords: [],
        timeInterval: {
          start: startDate,
          end: endDate ?  endDate : new Date()
        },
        timeBin : "day",
        geoLevel: "state",
        geoIds : [37,51,24,11,10,34,42,9,44,48,35,4,40,6,20,32,8,49,12,22,28,1,13,45,5,47,21,29,54,17,18,39,19,55,26,27,31,56,41,46,16,30,53,38,25,36,50,33,23,2]
      },

      queryType: "search",

      mapResult: [],
      timeResult: [],
      hashTagResult: [],
      errorMessage: null,

      query: function(parameters, queryType) {

        var sampleJson = (JSON.stringify({
          dataset: parameters.dataset,
          filter: getFilter(parameters, defaultSamplingDayRange, parameters.geoIds),
          select: {
            order: ["-create_at"],
            limit: defaultSamplingSize,
            offset: 0,
            field: ["create_at", "id", "user.id"]
          },
          transform: {
            wrap: {
              key: "sample"
            }
          }
        }));

        // Default request - time series, map result, and hash tag
        var batchWithGeoRequest = cloudberryConfig.querySlicingMills > 0 ? (JSON.stringify({
          batch: [byTimeRequest(parameters), byGeoRequest(parameters, parameters.geoIds),
            byHashTagRequest(parameters)],
          option: {
            sliceMillis: cloudberryConfig.querySlicingMills
          },
          transform: {
            wrap: {
              key: "batchWithGeoRequest"
            }
          }
        })) :
            (JSON.stringify({
            batch: [byTimeRequest(parameters), byGeoRequest(parameters, parameters.geoIds),
                byHashTagRequest(parameters)],
            transform: {
                wrap: {
                    key: "batchWithGeoRequest"
                }
            }
        }));

        // Batch request without map result - used when the complete map result cache hit case
        var batchWithoutGeoRequest = cloudberryConfig.querySlicingMills > 0 ? (JSON.stringify({
          batch: [byTimeRequest(parameters), byHashTagRequest(parameters)],
          option: {
            sliceMillis: cloudberryConfig.querySlicingMills
          },
          transform: {
            wrap: {
              key: "batchWithoutGeoRequest"
            }
          }
        })) : (JSON.stringify({
            batch: [byTimeRequest(parameters), byHashTagRequest(parameters)],
            transform: {
                wrap: {
                    key: "batchWithoutGeoRequest"
                }
            }
        }));

        geoIdsNotInCache = MapResultCache.getGeoIdsNotInCache(cloudberryService.parameters.keywords,
          cloudberryService.parameters.timeInterval,
          cloudberryService.parameters.geoIds, cloudberryService.parameters.geoLevel);

        // Batch request with only the geoIds whose map result are not cached yet - partial map result cache hit case
        var batchJsonWithPartialGeoRequest = cloudberryConfig.querySlicingMills > 0 ? (JSON.stringify({
          batch: [byTimeRequest(parameters), byGeoRequest(parameters, geoIdsNotInCache),
            byHashTagRequest(parameters)],
          option: {
            sliceMillis: cloudberryConfig.querySlicingMills
          },
          transform: {
            wrap: {
              key: "batchWithPartialGeoRequest"
            }
          }
        })) : (JSON.stringify({
            batch: [byTimeRequest(parameters), byGeoRequest(parameters, geoIdsNotInCache),
                byHashTagRequest(parameters)],
            transform: {
                wrap: {
                    key: "batchWithPartialGeoRequest"
                }
            }
        }));

        // Complete map result cache miss case
        if (geoIdsNotInCache.length === cloudberryService.parameters.geoIds.length) {
          ws.send(sampleJson);
          ws.send(batchWithGeoRequest);
        }
        // Complete map result cache hit case - exclude map result request
        else if(geoIdsNotInCache.length === 0)  {
          cloudberryService.mapResult = MapResultCache.getValues(cloudberryService.parameters.geoIds,
            cloudberryService.parameters.geoLevel);

          ws.send(sampleJson);
          ws.send(batchWithoutGeoRequest);
        }
        // Partial map result cache hit case
        else  {
          ws.send(sampleJson);
          ws.send(batchJsonWithPartialGeoRequest);
        }
      }
    };

    ws.onmessage = function(event) {
      $timeout(function() {
        var result = JSONbig.parse(event.data);

        switch (result.key) {

          case "sample":
            cloudberryService.tweetResult = result.value[0];
            break;
          case "batchWithGeoRequest":
            if(angular.isArray(result.value)) {
              cloudberryService.timeResult = result.value[0];
              cloudberryService.mapResult = result.value[1];
              cloudberryService.hashTagResult = result.value[2];
            }
            // When the query is executed completely, we update the map result cache.
            else  if(result.value['key'] === "done")  {
              MapResultCache.putValues(cloudberryService.parameters.geoIds,
                cloudberryService.parameters.geoLevel, cloudberryService.mapResult);
            }
            else {
              console.log('ws received unknown data: ', result);
            }
            break;
          case "batchWithoutGeoRequest":
            if(angular.isArray(result.value)) {
              cloudberryService.timeResult = result.value[0];
              cloudberryService.hashTagResult = result.value[1];
            }
            break;
          case "batchWithPartialGeoRequest":
            if(angular.isArray(result.value)) {
              cloudberryService.timeResult = result.value[0];
              cloudberryService.mapResult = cloudberryService.mapResult.concat(result.value[1]);
              cloudberryService.hashTagResult = result.value[2];
            }
            // When the query is executed completely, we update the map result cache.
            else if(result.value['key'] === "done") {
              MapResultCache.putValues(geoIdsNotInCache, cloudberryService.parameters.geoLevel,
                cloudberryService.mapResult);
              cloudberryService.mapResult = MapResultCache.getValues(cloudberryService.parameters.geoIds,
                cloudberryService.parameters.geoLevel);
            }
            else  {
              console.log('ws received unknown data: ', result);
            }
            break;
          case "totalCount":
            cloudberryService.totalCount = result.value[0][0].count;
            break;
          case "error":
            console.error(result);
            cloudberryService.errorMessage = result.value;
            break;
          case "done":
            break;
          default:
            console.error("ws get unknown data: ", result);
            cloudberryService.errorMessage = "ws get unknown data: " + result.toString();
            break;
        }
      });
    };

    return cloudberryService;
  });