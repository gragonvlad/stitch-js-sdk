/**
 * Copyright 2018-present MongoDB, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { EJSON } from "bson";
import { Codec, Decoder } from "../../internal/common/Codec";
import { wrapDecodingError } from "../../internal/common/StitchErrorUtils";
import { Storage } from "../../internal/common/Storage";
import ContentTypes from "../../internal/net/ContentTypes";
import Headers from "../../internal/net/Headers";
import Method from "../../internal/net/Method";
import Response from "../../internal/net/Response";
import Stream from "../../internal/net/Stream";
import EventStream from "../../internal/net/EventStream";
import { StitchAuthDocRequest } from "../../internal/net/StitchAuthDocRequest";
import { StitchAuthRequest } from "../../internal/net/StitchAuthRequest";
import { StitchDocRequest } from "../../internal/net/StitchDocRequest";
import { StitchRequest } from "../../internal/net/StitchRequest";
import StitchRequestClient from "../../internal/net/StitchRequestClient";
import StitchClientError from "../../StitchClientError";
import { StitchClientErrorCode } from "../../StitchClientErrorCode";
import StitchError from "../../StitchError";
import StitchRequestError from "../../StitchRequestError";
import { StitchRequestErrorCode } from "../../StitchRequestErrorCode";
import StitchServiceError from "../../StitchServiceError";
import { StitchServiceErrorCode } from "../../StitchServiceErrorCode";
import StitchAuthResponseCredential from "../providers/internal/StitchAuthResponseCredential";
import StitchCredential from "../StitchCredential";
import AccessTokenRefresher from "./AccessTokenRefresher";
import AuthInfo from "./AuthInfo";
import CoreStitchUser from "./CoreStitchUser";
import JWT from "./JWT";
import ApiAuthInfo from "./models/ApiAuthInfo";
import ApiCoreUserProfile from "./models/ApiCoreUserProfile";
import { readFromStorage, writeToStorage } from "./models/StoreAuthInfo";
import StitchAuthRequestClient from "./StitchAuthRequestClient";
import { StitchAuthRoutes } from "./StitchAuthRoutes";
import StitchUserFactory from "./StitchUserFactory";
import StitchUserProfileImpl from "./StitchUserProfileImpl";

const OPTIONS = "options";
const DEVICE = "device";

/**
 * @hidden
 * The core class that holds and manages Stitch user authentication state. This class is meant to be inherited.
 *
 * - typeparameters
 *     - TStitchUser: The underlying user type for this `CoreStitchAuth`, which must conform to `CoreStitchUser`.
 */
export default abstract class CoreStitchAuth<TStitchUser extends CoreStitchUser>
  implements StitchAuthRequestClient {
  /**
   * The authentication state, as represented by an `AuthInfo` object.
   */
  public authInfo: AuthInfo;

  /**
   * The `StitchRequestClient` used by the `CoreStitchAuth` to make requests to the Stitch server.
   */
  protected readonly requestClient: StitchRequestClient;
  /**
   * The `StitchAuthRoutes` object representing the authentication API routes
   * of the Stitch server for the current
   * app.
   */
  protected readonly authRoutes: StitchAuthRoutes;
  /**
   * Should return an `StitchUserFactory` object, capable of constructing users of the `TStitchUser` type.
   */
  protected abstract userFactory: StitchUserFactory<TStitchUser>;
  /**
   * A field that should return an object containing information about the current device.
   */
  protected abstract deviceInfo: { [key: string]: string };

  /**
   * The `IStorage` object indicating where authentication information should be persisted.
   */
  private readonly storage: Storage;
  /**
   * A `TStitchUser` object that represents the
   * currently authenticated user, or `undefined` if no one is authenticated.
   */
  private currentUser?: TStitchUser;

  private readonly accessTokenRefresher: AccessTokenRefresher<TStitchUser>;

  protected constructor(
    requestClient: StitchRequestClient,
    authRoutes: StitchAuthRoutes,
    storage: Storage,
    useTokenRefresher: boolean = true
  ) {
    this.requestClient = requestClient;
    this.authRoutes = authRoutes;
    this.storage = storage;

    let info: AuthInfo | undefined;
    try {
      info = readFromStorage(storage);
    } catch (e) {
      throw new StitchClientError(
        StitchClientErrorCode.CouldNotLoadPersistedAuthInfo
      );
    }
    if (info === undefined) {
      this.authInfo = AuthInfo.empty();
    } else {
      this.authInfo = info;
    }

    this.prepUser();

    if (useTokenRefresher) {
      this.accessTokenRefresher = new AccessTokenRefresher(this);
      this.accessTokenRefresher.run();
    }
  }

  /**
   * Whether or not a user is currently logged in.
   */
  public get isLoggedIn(): boolean {
    return this.currentUser !== undefined;
  }

  /**
   * The currently authenticated user as a `TStitchUser`, or `undefined` if no user is currently authenticated.
   */
  public get user(): TStitchUser | undefined {
    return this.currentUser;
  }

  /**
   * Performs an authenticated request to the Stitch server, using the current authentication state. Will throw when
   * when the `CoreStitchAuth` is not currently authenticated.
   *
   * - returns: The response to the request as a `Response`.
   */
  public doAuthenticatedRequest(
    stitchReq: StitchAuthRequest
  ): Promise<Response> {
    return this.requestClient
      .doRequest(this.prepareAuthRequest(stitchReq))
      .catch(err => {
        return this.handleAuthFailure(err, stitchReq);
      });
  }

  /**
   * Performs an authenticated request to the Stitch server with a JSON body, and decodes the extended JSON response into
   * an object. Uses the current authentication state, and will throw when the `CoreStitchAuth` is not currently authenticated.
   *
   * - returns: An `any` representing the decoded response body.
   */
  public doAuthenticatedRequestWithDecoder<T>(
    stitchReq: StitchAuthRequest,
    decoder?: Decoder<T>
  ): Promise<T> {
    return this.doAuthenticatedRequest(stitchReq)
      .then(response => {
        const obj = EJSON.parse(response.body!, { strict: false });

        if (decoder) {
          return decoder.decode(obj);
        }

        return obj;
      })
      .catch(err => {
        throw wrapDecodingError(err);
      });
  }

  public openAuthenticatedEventStream(
    stitchReq: StitchAuthRequest,
    open: boolean = true
  ): Promise<EventStream> {
    if (!this.isLoggedIn) {
      throw new StitchClientError(StitchClientErrorCode.MustAuthenticateFirst);
    }

    let authToken;
    if (stitchReq.useRefreshToken) {
      authToken = this.authInfo.refreshToken!
    } else {
      authToken = this.authInfo.accessToken!
    }

    return this.requestClient.doStreamRequest(
      stitchReq.builder
      .withPath(`${stitchReq.path}&stitch_at=${authToken}`)
      .build(),
      open,
      () => this.openAuthenticatedEventStream(stitchReq, false))
    .catch(err => {
      return this.handleAuthFailureForEventStream(err, stitchReq, open);
    });
  }

  public openAuthenticatedStreamWithDecoder<T>(
    stitchReq: StitchAuthRequest,
    decoder?: Decoder<T>
  ): Promise<Stream<T>> {
    return this.openAuthenticatedEventStream(stitchReq)
    .then(eventStream => {
      return new Stream<T>(eventStream, decoder)
    });
  }

  /**
   * Attempts to refresh the current access token.
   */
  public refreshAccessToken(): Promise<void> {
    const reqBuilder = new StitchAuthRequest.Builder()
      .withRefreshToken()
      .withPath(this.authRoutes.sessionRoute)
      .withMethod(Method.POST);

    return this.doAuthenticatedRequest(reqBuilder.build()).then(response => {
      try {
        const partialInfo = ApiAuthInfo.fromJSON(JSON.parse(response.body!));
        this.authInfo = this.authInfo.merge(partialInfo);
      } catch (err) {
        throw new StitchRequestError(
          err,
          StitchRequestErrorCode.DECODING_ERROR
        );
      }

      try {
        writeToStorage(this.authInfo, this.storage);
      } catch (err) {
        throw new StitchClientError(
          StitchClientErrorCode.CouldNotPersistAuthInfo
        );
      }
    });
  }

  /**
   * Authenticates the `CoreStitchAuth` using the provided `StitchCredential`. Blocks the current thread until the
   * request is completed.
   */
  public loginWithCredentialInternal(
    credential: StitchCredential
  ): Promise<TStitchUser> {
    if (credential instanceof StitchAuthResponseCredential) {
      return this.processLogin(credential, credential.authInfo, credential.asLink);
    }

    if (!this.isLoggedIn) {
      return this.doLogin(credential, false);
    }

    if (credential.providerCapabilities.reusesExistingSession) {
      if (credential.providerType === this.currentUser!.loggedInProviderType) {
        return Promise.resolve(this.currentUser!);
      }
    }

    this.logoutInternal();
    return this.doLogin(credential, false);
  }

  /**
   * Links the currently logged in user with a new identity represented by the provided `StitchCredential`. Blocks the
   * current thread until the request is completed.
   */
  public linkUserWithCredentialInternal(
    user: CoreStitchUser,
    credential: StitchCredential
  ): Promise<TStitchUser> {
    if (this.currentUser !== undefined && user.id !== this.currentUser.id) {
      return Promise.reject(
        new StitchClientError(StitchClientErrorCode.UserNoLongerValid)
      );
    }

    return this.doLogin(credential, true);
  }

  /**
   * Logs out the current user, and clears authentication state from this `CoreStitchAuth` as well as underlying
   * storage. Blocks the current thread until the request is completed. If the logout request fails, this method will
   * still attempt to clear local authentication state. This method will only throw if clearing authentication state
   * fails.
   */
  public logoutInternal(): Promise<void> {
    if (!this.isLoggedIn) {
      return Promise.resolve();
    }

    // Promise.finally needs to be added as a shim
    // to TS. Until we need another .finally, we
    // will need this workaround for cleanup
    return this.doLogout()
      .then(() => {
        this.clearAuth();
      })
      .catch(() => {
        this.clearAuth();
      });
  }

  /**
   * Returns whether or not the current authentication state has a meaningful device id.
   */
  public get hasDeviceId(): boolean {
    return (
      this.authInfo.deviceId !== undefined &&
      this.authInfo.deviceId !== "" &&
      this.authInfo.deviceId !== "000000000000000000000000"
    );
  }

  /**
   * Returns the currently authenticated user's device id, or `undefined` is no user is currently authenticated, or if the
   * device id does not exist.
   */
  protected get deviceId(): string | undefined {
    if (!this.hasDeviceId) {
      return undefined;
    }

    return this.authInfo.deviceId;
  }

  protected abstract onAuthEvent();

  /**
   * Prepares an authenticated Stitch request by attaching the `CoreStitchAuth`'s current access or refresh token
   * (depending on the type of request) to the request's `"Authorization"` header.
   */
  private prepareAuthRequest(stitchReq: StitchAuthRequest): StitchRequest {
    if (!this.isLoggedIn) {
      throw new StitchClientError(StitchClientErrorCode.MustAuthenticateFirst);
    }

    const newReq = stitchReq.builder;
    const newHeaders = newReq.headers || {}; // This is not a copy

    if (stitchReq.useRefreshToken) {
      newHeaders[Headers.AUTHORIZATION] = Headers.getAuthorizationBearer(
        this.authInfo.refreshToken!
      );
    } else {
      newHeaders[Headers.AUTHORIZATION] = Headers.getAuthorizationBearer(
        this.authInfo.accessToken!
      );
    }
    newReq.withHeaders(newHeaders);
    return newReq.build();
  }

  private handleAuthFailureForEventStream(
    ex: StitchError,
    req: StitchAuthRequest,
    open: boolean = true
  ): Promise<EventStream> {
    if (
      !(ex instanceof StitchServiceError) ||
      ex.errorCode !== StitchServiceErrorCode.InvalidSession
    ) {
      throw ex;
    }

    // using a refresh token implies we cannot refresh anything, so clear auth and
    // notify
    if (req.useRefreshToken || !req.shouldRefreshOnFailure) {
      this.clearAuth();
      throw ex;
    }

    return this.tryRefreshAccessToken(req.startedAt).then(() => {
      return this.openAuthenticatedEventStream(
        req.builder.withShouldRefreshOnFailure(false).build(),
        open
      );
    });
  }

  /**
   * Checks the `StitchServiceError` object provided in the `forError` parameter, and if it's an error indicating an invalid
   * Stitch session, it will handle the error by attempting to refresh the access token if it hasn't been attempted
   * already. If the error is not a Stitch error, or the error is a Stitch error not related to an invalid session,
   * it will be re-thrown.
   */
  private handleAuthFailure(
    ex: StitchError,
    req: StitchAuthRequest
  ): Promise<Response> {
    if (
      !(ex instanceof StitchServiceError) ||
      ex.errorCode !== StitchServiceErrorCode.InvalidSession
    ) {
      throw ex;
    }

    // using a refresh token implies we cannot refresh anything, so clear auth and
    // notify
    if (req.useRefreshToken || !req.shouldRefreshOnFailure) {
      this.clearAuth();
      throw ex;
    }

    return this.tryRefreshAccessToken(req.startedAt).then(() => {
      return this.doAuthenticatedRequest(
        req.builder.withShouldRefreshOnFailure(false).build()
      );
    });
  }

  /**
   * Checks if the current access token is expired or going to expire soon, and refreshes the access token if
   * necessary.
   */
  private tryRefreshAccessToken(reqStartedAt: number): Promise<void> {
    // use this critical section to create a queue of pending outbound requests
    // that should wait on the result of doing a token refresh or logout. This will
    // prevent too many refreshes happening one after the other.
    if (!this.isLoggedIn) {
      throw new StitchClientError(StitchClientErrorCode.LoggedOutDuringRequest);
    }

    try {
      const jwt = JWT.fromEncoded(this.authInfo.accessToken!);
      if (jwt.issuedAt >= reqStartedAt) {
        return Promise.resolve();
      }
    } catch (e) {
      // Swallow
    }

    // retry
    return this.refreshAccessToken();
  }

  private prepUser() {
    if (this.authInfo.userId !== undefined) {
      // this implies other properties we are interested should be set
      this.currentUser = this.userFactory.makeUser(
        this.authInfo.userId,
        this.authInfo.loggedInProviderType!,
        this.authInfo.loggedInProviderName!,
        this.authInfo.userProfile
      );
    }
  }

  /**
   * Attaches authentication options to the BSON document passed in as the `authBody` parameter. Necessary for the
   * the login request.
   */
  private attachAuthOptions(authBody: object) {
    const options = {};
    options[DEVICE] = this.deviceInfo;
    authBody[OPTIONS] = options;
  }

  /**
   * Performs the logic of logging in this `CoreStitchAuth` as a new user with the provided credential. Can also
   * perform a user link if the `asLinkRequest` parameter is true.
   */
  private doLogin(
    credential: StitchCredential,
    asLinkRequest: boolean
  ): Promise<TStitchUser> {
    return this.doLoginRequest(credential, asLinkRequest)
      .then(response => this.processLoginResponse(credential, response, asLinkRequest))
      .then(user => {
        this.onAuthEvent();
        return user;
      });
  }

  /**
   * Performs the login request against the Stitch server. If `asLinkRequest` is true, a link request is performed
   * instead.
   */
  private doLoginRequest(
    credential: StitchCredential,
    asLinkRequest: boolean
  ): Promise<Response> {
    const reqBuilder = new StitchDocRequest.Builder();
    reqBuilder.withMethod(Method.POST);

    if (asLinkRequest) {
      reqBuilder.withPath(
        this.authRoutes.getAuthProviderLinkRoute(credential.providerName)
      );
    } else {
      reqBuilder.withPath(
        this.authRoutes.getAuthProviderLoginRoute(credential.providerName)
      );
    }

    const material = credential.material;
    this.attachAuthOptions(material);
    reqBuilder.withDocument(material);

    if (!asLinkRequest) {
      return this.requestClient.doRequest(reqBuilder.build());
    }
    const linkRequest = new StitchAuthDocRequest(
      reqBuilder.build(),
      reqBuilder.document
    );

    return this.doAuthenticatedRequest(linkRequest);
  }

  /**
   * Processes the authentication info from the login/link request, setting the authentication state, and
   * requesting the user profile in a separate request.
   */
  private processLogin(
    credential: StitchCredential,
    newAuthInfo: AuthInfo,
    asLinkRequest: boolean
  ): Promise<TStitchUser> {

    // Preserve old auth info in case of profile request failure
    const oldInfo = this.authInfo;
    const oldUser = this.currentUser;

    newAuthInfo = this.authInfo.merge(
      new AuthInfo(
        newAuthInfo.userId,
        newAuthInfo.deviceId,
        newAuthInfo.accessToken,
        newAuthInfo.refreshToken,
        credential.providerType,
        credential.providerName,
        undefined
      )
    );

    // Provisionally set so we can make a profile request
    this.authInfo = newAuthInfo;
    this.currentUser = this.userFactory.makeUser(
      this.authInfo.userId!,
      credential.providerType,
      credential.providerName,
      undefined
    );

    return this.doGetUserProfile()
      .then(profile => {
        newAuthInfo = newAuthInfo.merge(
          new AuthInfo(
            newAuthInfo.userId,
            newAuthInfo.deviceId,
            newAuthInfo.accessToken,
            newAuthInfo.refreshToken,
            credential.providerType,
            credential.providerName,
            profile
          )
        );

        try {
          writeToStorage(newAuthInfo, this.storage);
        } catch (err) {
          throw new StitchClientError(
            StitchClientErrorCode.CouldNotPersistAuthInfo
          );
        }

        this.authInfo = newAuthInfo;
        this.currentUser = this.userFactory.makeUser(
          this.authInfo.userId!,
          credential.providerType,
          credential.providerName,
          profile
        );

        return this.currentUser;
      })
      .catch(err => {
        // If this was a link request, back out of setting authInfo and reset any created user. This
        // will keep the currently logged in user logged in if the profile request failed, and in
        // this particular edge case the user is linked, but they are logged in with their older
        // credentials.
        if (asLinkRequest) {
          this.authInfo = oldInfo;
          this.currentUser = oldUser; 
        } else { // otherwise this was a normal login request, log the user out
          this.clearAuth();
        }

        throw err;
      });
  }

  /**
   * Processes the response of the login/link request, setting the authentication state if appropriate, and
   * requesting the user profile in a separate request.
   */
  private processLoginResponse(
    credential: StitchCredential,
    response: Response,
    asLinkRequest: boolean
  ): Promise<TStitchUser> {
    try {
      if (!response) {
        throw new StitchServiceError(
          `the login response could not be processed for credential: ${credential};` +
            `response was undefined`
        );
      }
      if (!response.body) {
        throw new StitchServiceError(
          `response with status code ${response.statusCode} has empty body`
        );
      }
      return this.processLogin(
        credential,
        ApiAuthInfo.fromJSON(JSON.parse(response.body!)),
        asLinkRequest
      );
    } catch (err) {
      throw new StitchRequestError(err, StitchRequestErrorCode.DECODING_ERROR);
    }
  }

  /**
   * Performs a request against the Stitch server to get the currently authenticated user's profile.
   */
  private doGetUserProfile(): Promise<StitchUserProfileImpl> {
    const reqBuilder = new StitchAuthRequest.Builder();
    reqBuilder.withMethod(Method.GET).withPath(this.authRoutes.profileRoute);

    return this.doAuthenticatedRequest(reqBuilder.build())
      .then(response => ApiCoreUserProfile.fromJSON(JSON.parse(response.body!)))
      .catch(err => {
        if (err instanceof StitchError) {
          throw err;
        } else {
          throw new StitchRequestError(
            err,
            StitchRequestErrorCode.DECODING_ERROR
          );
        }
      });
  }

  /**
   * Performs a logout request against the Stitch server.
   */
  private doLogout(): Promise<void> {
    const reqBuilder = new StitchAuthRequest.Builder();
    reqBuilder
      .withRefreshToken()
      .withPath(this.authRoutes.sessionRoute)
      .withMethod(Method.DELETE);
    return this.doAuthenticatedRequest(reqBuilder.build()).then(() => {
      return;
    });
  }

  /**
   * Clears the `CoreStitchAuth`'s authentication state, as well as associated authentication state in underlying
   * storage.
   */
  private clearAuth() {
    if (!this.isLoggedIn) {
      return;
    }
    this.authInfo = this.authInfo.loggedOut();
    try {
      writeToStorage(this.authInfo, this.storage);
    } catch (e) {
      throw new StitchClientError(
        StitchClientErrorCode.CouldNotPersistAuthInfo
      );
    }
    this.currentUser = undefined;
    this.onAuthEvent();
  }

  /**
   * Close stops any background processes maintained by auth. This
   * should be called when auth services are no longer needed.
   */
  public close() {
    if (this.accessTokenRefresher) {
      this.accessTokenRefresher.stop();
    }
  }
}
