/*
 * Copyright 2023 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import configs from "./config-analytics.js";

/**
 * Customer's XDM schema namespace
 * @type {string}
 */
const CUSTOM_SCHEMA_NAMESPACE = configs.tenantId;
let documentUnloading = false;

/**
 * Returns experiment id and variant running
 * @returns {{experimentVariant: *, experimentId}}
 */
export function getExperimentDetails() {
  if (!window.hlx || !window.hlx.experiment) {
    return null;
  }
  const { id: experimentId, selectedVariant: experimentVariant } =
    window.hlx.experiment;
  return { experimentId, experimentVariant };
}

/**
 * Return document last modified
 */
const dateTimeFormatOptions = [
  "en-US",
  { month: "2-digit", day: "2-digit", year: "numeric" },
];
export function getLastModified() {
  const lastModified = document.lastModified;
  if (lastModified) {
    const [month, day, year] = new Intl.DateTimeFormat(...dateTimeFormatOptions)
      .format(new Date(lastModified))
      .split("/");
    return `${year}-${month}-${day}`;
  }

  return "unknown";
}

/**
 * Return experienceId
 */
export function getExperienceId() {
  const url = new URL(window.location.href);
  if (!window.hlx) {
    return `${url.href}.${getLastModified()}`;
  }

  // check for campaigns, experiments, audiences
  let servedExperiencePathname = null;
  if (window.hlx.campaign && window.hlx.campaign.servedExperience) {
    servedExperiencePathname = window.hlx.campaign.servedExperience;
  } else if (window.hlx.experiment && window.hlx.experiment.servedExperience) {
    servedExperiencePathname = window.hlx.experiment.servedExperience;
  } else if (window.hlx.audience && window.hlx.audience.servedExperience) {
    servedExperiencePathname = window.hlx.audience.servedExperience;
  }

  if (servedExperiencePathname) {
    if (servedExperiencePathname.endsWith("index.plain.html")) {
      servedExperiencePathname = servedExperiencePathname.slice(0, -14);
    }
    if (servedExperiencePathname.endsWith(".plain.html")) {
      servedExperiencePathname = servedExperiencePathname.slice(0, -11);
    }

    url.pathname = servedExperiencePathname;
    return `${url.href}.${getLastModified()}`;
  }

  return `${url.href}.${getLastModified()}`;
}

/**
 * Returns script that initializes a queue for each alloy instance,
 * in order to be ready to receive events before the alloy library is loaded
 * Documentation
 * https://experienceleague.adobe.com/docs/experience-platform/edge/fundamentals/installing-the-sdk.html?lang=en#adding-the-code
 * @type {string}
 */
function getAlloyInitScript() {
  return `!function(n,o){o.forEach(function(o){n[o]||((n.__alloyNS=n.__alloyNS||[]).push(o),n[o]=
  function(){var u=arguments;return new Promise(function(i,l){n[o].q.push([i,l,u])})},n[o].q=[])})}(window,["alloy"]);`;
}

/**
 * Returns datastream id to use as edge configuration id
 * Custom logic can be inserted here in order to support
 * different datastream ids for different environments (non-prod/prod)
 * @returns {{edgeConfigId: string, orgId: string}}
 */
function getDatastreamConfiguration() {
  return {
    edgeConfigId: configs.edgeConfigId,
    orgId: configs.orgId,
  };
}

/**
 * Condor asset, experience ids version
 */
const condorAssetIdVersion = "5";
const condorExperienceIdVersion = "5";
/**
 * Enhance all events with additional details, like experiment running,
 * before sending them to the edge EXCEPT for condor events.
 * @param options event in the XDM schema format
 */
function enhanceAnalyticsEvent(options) {
  // Bypass default enhancements for condor events
  if (
    options.xdm[CUSTOM_SCHEMA_NAMESPACE] &&
    options.xdm[CUSTOM_SCHEMA_NAMESPACE].condor
  ) {
    // TODO: Drop some of the default tracking props
    delete options.xdm.device;
    delete options.xdm.implementationDetails;
    delete options.xdm.placeContext;
    delete options.xdm.environment;
    // Optional: Add condor implementation details
    options.xdm[CUSTOM_SCHEMA_NAMESPACE].condor.implementationDetails = {
      assetIdVersion: condorAssetIdVersion,
      experienceIdVersion: condorExperienceIdVersion,
    };
    return;
  }

  const experiment = getExperimentDetails();
  options.xdm[CUSTOM_SCHEMA_NAMESPACE] = {
    ...options.xdm[CUSTOM_SCHEMA_NAMESPACE],
    ...(experiment && { experiment }), // add experiment details, if existing, to all events
  };
  console.debug(`enhanceAnalyticsEvent complete: ${JSON.stringify(options)}`);
}

/**
 * Returns alloy configuration
 * Documentation https://experienceleague.adobe.com/docs/experience-platform/edge/fundamentals/configuring-the-sdk.html
 */
function getAlloyConfiguration(document) {
  const { hostname } = document.location;
  const debugEnabled =
    hostname.startsWith("localhost") || hostname.includes("--");
  documentUnloading = !debugEnabled;

  return {
    // enable while debugging
    debugEnabled,
    // disable when clicks are also tracked via sendEvent with additional details
    clickCollectionEnabled: true,
    // adjust default based on customer use case
    defaultConsent: "in",
    ...getDatastreamConfiguration(),
    onBeforeEventSend: (options) => enhanceAnalyticsEvent(options),
    prehidingStyle: "body { opacity: 0 !important }",
  };
}

/**
 * Create inline script
 * @param document
 * @param element where to create the script element
 * @param innerHTML the script
 * @param type the type of the script element
 * @returns {HTMLScriptElement}
 */
function createInlineScript(document, element, innerHTML, type) {
  const script = document.createElement("script");
  script.type = type;
  script.innerHTML = innerHTML;
  element.appendChild(script);
  return script;
}

/**
 * Sends an analytics event to alloy
 * @param xdmData - the xdm data object
 * @returns {Promise<*>}
 */
async function sendAnalyticsEvent(xdmData, renderDecisions = false) {
  // eslint-disable-next-line no-undef
  if (!alloy) {
    console.warn("alloy not initialized, cannot send analytics event");
    return Promise.resolve();
  }

  // drain viewed assets before sending behavior event
  // drainAssetsQueue();

  // eslint-disable-next-line no-undef
  return alloy("sendEvent", {
    renderDecisions,
    documentUnloading,
    xdm: xdmData,
  });
}

/**
 * Sets Adobe standard v1.0 consent for alloy based on the input
 * Documentation: https://experienceleague.adobe.com/docs/experience-platform/edge/consent/supporting-consent.html?lang=en#using-the-adobe-standard-version-1.0
 * @param approved
 * @returns {Promise<*>}
 */
export async function analyticsSetConsent(approved) {
  // eslint-disable-next-line no-undef
  if (!alloy) {
    console.warn("alloy not initialized, cannot set consent");
    return Promise.resolve();
  }

  // if(approved) {
  //   debouncedDrainAssetsQueue();
  // }

  // eslint-disable-next-line no-undef
  return alloy("setConsent", {
    consent: [
      {
        standard: "Adobe",
        version: "1.0",
        value: {
          general: approved ? "in" : "out",
        },
      },
    ],
  });
}

/**
 * Basic tracking for page views with alloy
 * @param document
 * @param additionalXdmFields
 * @returns {Promise<*>}
 */
export async function analyticsTrackPageViews(
  document,
  additionalXdmFields = {}
) {
  const xdmData = {
    eventType: "web.webpagedetails.pageViews",
    web: {
      webPageDetails: {
        pageViews: {
          value: 1,
        },
        name: `${document.title}`,
      },
    },
    [CUSTOM_SCHEMA_NAMESPACE]: {
      ...additionalXdmFields,
    },
  };

  return sendAnalyticsEvent(xdmData, true);
}

/**
 * Initializes event queue for analytics tracking using alloy
 * @returns {Promise<void>}
 */
export async function initAnalyticsTrackingQueue() {
  createInlineScript(
    document,
    document.body,
    getAlloyInitScript(),
    "text/javascript"
  );
}

/**
 * Sets up analytics tracking with alloy (initializes and configures alloy)
 * @param document
 * @returns {Promise<void>}
 */
export async function setupAnalyticsTrackingWithAlloy(document) {
  // eslint-disable-next-line no-undef
  if (!alloy) {
    console.warn("alloy not initialized, cannot configure");
    return;
  }
  // eslint-disable-next-line no-undef
  const configurePromise = alloy("configure", getAlloyConfiguration(document));

  // Custom logic can be inserted here in order to support early tracking before alloy library
  // loads, for e.g. for page views
  const pageViewPromise = analyticsTrackPageViews(document); // track page view early

  // assets tracking
  // const assetsViewedPromise = trackAssetsViews(document);
  // const assetsClickedPromise = trackAssetsClicks(document);

  await import("./alloy.min.js");
  await Promise.all([configurePromise, pageViewPromise]);
}

/**
 * Basic tracking for link clicks with alloy
 * Documentation: https://experienceleague.adobe.com/docs/experience-platform/edge/data-collection/track-links.html
 * @param element
 * @param linkType
 * @param additionalXdmFields
 * @returns {Promise<*>}
 */
export async function analyticsTrackLinkClicks(
  element,
  linkType = "other",
  additionalXdmFields = {}
) {
  const xdmData = {
    eventType: "web.webinteraction.linkClicks",
    web: {
      webInteraction: {
        URL: `${element.href}`,
        // eslint-disable-next-line no-nested-ternary
        name: `${
          element.text
            ? element.text.trim()
            : element.innerHTML
            ? element.innerHTML.trim()
            : ""
        }`,
        linkClicks: {
          value: 1,
        },
        type: linkType,
      },
    },
    [CUSTOM_SCHEMA_NAMESPACE]: {
      ...additionalXdmFields,
    },
  };

  return sendAnalyticsEvent(xdmData);
}

/**
 * Basic tracking for CWV events with alloy
 * @param cwv
 * @returns {Promise<*>}
 */
export async function analyticsTrackCWV(cwv) {
  const xdmData = {
    eventType: "web.performance.measurements",
    [CUSTOM_SCHEMA_NAMESPACE]: {
      cwv,
    },
  };

  return sendAnalyticsEvent(xdmData);
}

/**
 * Basic tracking for 404 errors with alloy
 * @param data
 * @param additionalXdmFields
 * @returns {Promise<*>}
 */
export async function analyticsTrack404(data, additionalXdmFields = {}) {
  const xdmData = {
    eventType: "web.webpagedetails.pageViews",
    web: {
      webPageDetails: {
        pageViews: {
          value: 0,
        },
      },
    },
    [CUSTOM_SCHEMA_NAMESPACE]: {
      isPageNotFound: true,
      ...additionalXdmFields,
    },
  };

  return sendAnalyticsEvent(xdmData);
}

export async function analyticsTrackError(data, additionalXdmFields = {}) {
  const xdmData = {
    eventType: "web.webpagedetails.pageViews",
    web: {
      webPageDetails: {
        pageViews: {
          value: 0,
        },
        isErrorPage: true,
      },
    },
    [CUSTOM_SCHEMA_NAMESPACE]: {
      ...additionalXdmFields,
    },
  };

  return sendAnalyticsEvent(xdmData);
}

export async function analyticsTrackConversion(data, additionalXdmFields = {}) {
  const { source: conversionName, target: conversionValue, element } = data;

  const xdmData = {
    eventType: "web.webinteraction.conversion",
    [CUSTOM_SCHEMA_NAMESPACE]: {
      conversion: {
        conversionComplete: 1,
        conversionName,
        conversionValue,
      },
      ...additionalXdmFields,
    },
  };

  if (element.tagName === "FORM") {
    xdmData.eventType = "web.formFilledOut";
    const formId = element?.id || element?.dataset?.action;
    xdmData[CUSTOM_SCHEMA_NAMESPACE].form = {
      ...(formId && { formId }),
      // don't count as form complete, as this event should be tracked separately,
      // track only the details of the form together with the conversion
      formComplete: 0,
    };
  } else if (element.tagName === "A") {
    xdmData.eventType = "web.webinteraction.linkClicks";
    xdmData.web = {
      webInteraction: {
        URL: `${element.href}`,
        // eslint-disable-next-line no-nested-ternary
        name: `${
          element.text
            ? element.text.trim()
            : element.innerHTML
            ? element.innerHTML.trim()
            : ""
        }`,
        linkClicks: {
          // don't count as link click, as this event should be tracked separately,
          // track only the details of the link with the conversion
          value: 0,
        },
        type: "other",
      },
    };
  }

  return sendAnalyticsEvent(xdmData);
}

/**
 * Basic tracking for form submissions with alloy
 * @param element
 * @param additionalXdmFields
 * @returns {Promise<*>}
 */
export async function analyticsTrackFormSubmission(
  element,
  additionalXdmFields = {}
) {
  const formId = element?.id || element?.dataset?.action;
  const xdmData = {
    eventType: "web.formFilledOut",
    [CUSTOM_SCHEMA_NAMESPACE]: {
      form: {
        ...(formId && { formId }),
        formComplete: 1,
      },
      ...additionalXdmFields,
    },
  };

  return sendAnalyticsEvent(xdmData);
}

/**
 * Basic tracking for video play with alloy
 * @param element
 * @param additionalXdmFields
 * @returns {Promise<*>}
 */
export async function analyticsTrackVideo(
  { id, name, type, hasStarted, hasCompleted, progressMarker },
  additionalXdmFields
) {
  const primaryAssetReference = {
    id: `${id}`,
    dc: {
      title: `${name}`,
    },
    showType: `${type}`,
  };
  const baseXdm = {
    [CUSTOM_SCHEMA_NAMESPACE]: {
      media: {
        mediaTimed: {
          primaryAssetReference,
        },
      },
      ...additionalXdmFields,
    },
  };

  if (hasStarted) {
    baseXdm[CUSTOM_SCHEMA_NAMESPACE].media.mediaTimed.impressions = {
      value: 1,
    };
  } else if (hasCompleted) {
    baseXdm[CUSTOM_SCHEMA_NAMESPACE].media.mediaTimed.completes = { value: 1 };
  } else if (progressMarker) {
    baseXdm[CUSTOM_SCHEMA_NAMESPACE].media.mediaTimed[progressMarker] = {
      value: 1,
    };
  } else {
    return Promise.resolve();
  }

  return sendAnalyticsEvent(baseXdm);
}

// /**
//  * Customer's Condor assets event dataset id
//  * @type {string}
//  */
// const CONDOR_DATASET_ID = '655e1f4aea251428d3821ea8';

// /**
//  * Assets views debounce timeout
//  */
// const ASSETS_VIEWS_DEBOUNCE_TIMEOUT = 5000; // 2.5 seconds
// /**
//  * Debounces a function
//  */
// function debounce(func, timeout = ASSETS_VIEWS_DEBOUNCE_TIMEOUT) {
//   let timer;
//   return (...args) => {
//     clearTimeout(timer);
//     timer = setTimeout(() => {
//       func.apply(this, args);
//     }, timeout);
//   };
// }

// /**
//  * Extract asset url
//  */
// const assetSrcURL = (element) => {
//   const value = element.currentSrc || element.src || element.getAttribute('src');
//   if (value && value.startsWith('https://')) {
//     // resolve relative links
//     const srcURL = new URL(value, window.location);
//     srcURL.search = '';
//     return srcURL;
//   }

//   const srcURL = new URL(value);
//   srcURL.search = '';
//   return srcURL;
// };

// /**
//  * Sends an analytics condor event to alloy
//  * @param xdmData - the xdm data object
//  * @returns {Promise<*>}
//  */
// async function sendCondorEvent(xdmData) {
//   // eslint-disable-next-line no-undef
//   if (!alloy) {
//     console.warn('alloy not initialized, cannot send analytics event');
//     return Promise.resolve();
//   }

//   // eslint-disable-next-line no-undef
//   return alloy('sendEvent', {
//     documentUnloading,
//     xdm: xdmData,
//     edgeConfigOverrides: {
//       com_adobe_experience_platform: {
//         datasets: { event: { datasetId: CONDOR_DATASET_ID } }
//       },
//     },
//   });
// }

// /**
//  * Basic tracking for assets views with alloy
//  * @param assets - string[]
//  * @returns {Promise<*>}
//  */
// export async function analyticsTrackAssetsViews(assets) {
//   const xdmData = {
//     [CUSTOM_SCHEMA_NAMESPACE]: {
//       condor: {
//         assets: { ids: assets, type: 'image' },
//         experience: { id: getExperienceId() },
//         eventType: 'viewed',
//       },
//     },
//   };

//   return sendCondorEvent(xdmData);
// }

// /**
//  * Basic tracking for assets clicks with alloy
//  * @param url - string
//  * @param assets - string[]
//  * @returns {Promise<*>}
//  */
// export async function analyticsTrackAssetsClicked(assets, URL) {
//   const xdmData = {
//     eventType: 'web.webinteraction.linkClicks',
//     web: { webInteraction: { URL, linkClicks: { value: 1 }, type: 'other' } }, // linkType can be 'download' or 'other'
//     [CUSTOM_SCHEMA_NAMESPACE]: {
//       condor: {
//         assets: { ids: assets, type: 'image' },
//         experience: { id: getExperienceId() },
//         eventType: 'clicked',
//       },
//     },
//   };

//   return sendCondorEvent(xdmData);
// }

// // Assets views
// const assetsViews = new Set();
// export function trackAssetsViews(document) {
//   const docAssets = document.querySelectorAll('picture > img');
//   docAssets.forEach((assetElement) => {
//     const tag = assetElement.tagName.toLowerCase();
//     if (tag === 'img') {
//       imageObserver.observe(assetElement);
//     }
//   });
// };

// function drainAssetsQueue() {
//   if (assetsViews.size) {
//     analyticsTrackAssetsViews(Array.from(assetsViews));
//     assetsViews.clear();
//   }
// }
// const debouncedDrainAssetsQueue = debounce(() => drainAssetsQueue());
// window.addEventListener('visibilitychange', drainAssetsQueue);
// window.addEventListener('pagehide', drainAssetsQueue);

// const imageObserver = window.IntersectionObserver
//   ? new IntersectionObserver(
//     (entries) => {
//       entries
//         .filter((entry) => entry.isIntersecting)
//         .forEach((entry) => {
//           imageObserver.unobserve(entry.target);
//           assetsViews.add(assetSrcURL(entry.target).href);
//           debouncedDrainAssetsQueue();
//         });
//     },
//     { threshold: 0.5 },
//   )
//   : { observe: () => {} };

// // Assets clicks
// export const trackAssetsClicks = (document) => {
//   const docAssets = document.querySelectorAll('a > picture > img');
//   docAssets.forEach((assetElement) => {
//     assetElement.addEventListener("click", () => {
//       const href = assetElement.parentElement.parentElement.href;
//       analyticsTrackAssetsClicked([assetSrcURL(assetElement).href], href);
//     });
//   });
// }
