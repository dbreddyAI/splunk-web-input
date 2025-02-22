require.config({
    paths: {
        "text": "../app/website_input/js/lib/text",
        "preview_website_input_results" : "../app/website_input/js/views/PreviewWebsiteInputResultsView",
		"setup_view" : "../app/website_input/js/views/SetupView"
    }
});

define([
    "underscore",
    "backbone",
    "models/SplunkDBase",
    "collections/SplunkDsBase",
    "splunkjs/mvc",
    "util/splunkd_utils",
    "jquery",
    "splunkjs/mvc/simplesplunkview",
	"models/services/server/ServerInfo",
    'views/shared/controls/StepWizardControl',
    "splunkjs/mvc/simpleform/input/dropdown",
    "splunkjs/mvc/simpleform/input/text",
    "preview_website_input_results",
	"setup_view",
    'text!../app/website_input/js/templates/WebsiteInputCreateView.html',
    "bootstrap.dropdown",
    "css!../app/website_input/css/WebsiteInputCreateView.css"
], function(
    _,
    Backbone,
    SplunkDBaseModel,
    SplunkDsBaseCollection,
    mvc,
    splunkd_utils,
    $,
    SimpleSplunkView,
	ServerInfo,
    StepWizardControl,
    DropdownInput,
    TextInput,
    PreviewWebsiteInputResultsView,
	SetupView,
    Template
){
	
	var Indexes = SplunkDsBaseCollection.extend({
	    url: "data/indexes",
	    initialize: function() {
	      SplunkDsBaseCollection.prototype.initialize.apply(this, arguments);
	    }
	});
	
    // Define the custom view class
	// Note: this view is going to inherit from SetupView in order to gain access to the secure password helper functions.ada
    var WebsiteInputCreateView = SetupView.extend({
        className: "WebsiteInputCreateView",
        
        defaults: {
            "secure_storage_realm_prefix" : "web_input://",
            "secure_storage_username" : "IN_CONF_FILE"
        },
        
        events: {
        	"change #inputURL" : "clickUpdatePreview",
        	"click #do-preview" : "clickUpdatePreview",
        	"click .preview-url" : "clickUpdatePreview",
        	"click .clearSelector" : "clearSelector",
        	"change #inputSelector" : "changeInputSelector",
        	"keypress #inputSelector" : "keypressInputSelector",
        	"click .show-selector-help-dialog": "showSelectorHelp",
        	"click .switch-styles": "switchStyles",
        	"click .show-results-preview-dialog" : "showResultsPreview",
        	"click .show-results-in-search" : "openPreviewInSearch",
			"click #browserConnectionTest" : "clickTestBrowser",
			"change #inputBrowser" : "clearTestBrowserLink",
			"click .browserHelp" : "showBrowserHelp",
			"change #inputLoginURL" : "determineFormFields",
			"click #detect-field-names" : "clickDetermineFormFields",
			"click .authenticationHelp" : "showAuthenticationHelp",
			"change #inputPageLimit" : "changeInputSelector",
			"click #suggestURLFilter" : "suggestURLFilter",
        },
        
        initialize: function() {
        	this.options = _.extend({}, this.defaults, this.options);
        	
        	// These are internal variables
        	this.capabilities = null; // The list of capabilities the user has
			this.is_using_free_license = null; // Indicates whether the free license is being used
        	this.inputs = null; // The list of inputs
        	this.existing_input_names = []; // The list if existing inputs names (to help make a name that isn't used yet)
        	this.selector_gadget_added_interval = null; // The interval that keeps checking to see if the selectot gadget is loaded in the iframe
        	this.previous_sg_value = null; // The previous value of the selector gadget selector
        	this.sg_loaded = false; // Indicates if the selector gadget was loaded yet
        	this.fetched_input_name = null; // The name of the input that was loaded
        	this.fetched_input_owner = null; // The owner of the input that was loaded
        	this.fetched_input_namespace = null; // The namespace of the input that was loaded
        	this.form_key = Splunk.util.getFormKey(); // The form key to use for to work with Splunk's CSRF protection
        	this.loaded_iframe_url = null; // The URL of the site loaded in the iframe
			this.is_on_cloud = null; // Remembers if the host is on cloud

        	// Get the list of existing inputs
        	this.getExistingInputs();
        	
        	// Get the indexes
        	this.indexes = new Indexes();
        	this.indexes.on('reset', this.gotIndexes.bind(this), this);
        	
        	this.indexes.fetch({
                success: function() {
                  console.info("Successfully retrieved the list of indexes");
                },
                error: function() {
                  console.error("Unable to fetch the indexes");
                }
            });
			
			// Load the stylesheet for the step control wizard if we are on an older version of Splunk that doesn't include it automatically
			var version = $C.VERSION_LABEL.split('.');

            if (version.length > 1) {
                var major = Number(version[0]);

                if (major <= 6) {
                    require(["css!../app/website_input/css/StepControlWizard.css",]);
                }
            }

        	// Start syncing the selector gadget back to the form
        	setInterval(this.syncSelectorGadget.bind(this), 100);
        	
        	// Start the interval to make sure that the selector gadget was loaded in the frame
        	setInterval(this.tryToLoadSelectorGadget.bind(this), 2000);
        },
        
        /**
         * Show the selector help dialog.
         */
        showSelectorHelp: function(){
        	$("#selector-help-dialog", this.$el).modal();
			return false;
		},
		
		/**
         * Show the authentication help dialog.
         */
		showAuthenticationHelp: function(){
        	$("#authentication-help-dialog", this.$el).modal();
			return false;
		},
        
        /**
         * Add the given item to the associative array if it is non-blank
         */
        addIfInputIsNonEmpty: function(d, name, inputid){
        	
        	if($(inputid, this.$el).val().length > 0){
        		d[name] = $(inputid, this.$el).val();
        	}
        	
        },
        
        /**
         * Add the given item to the associative array based on whether it is checked.
         */
        addCheckboxInput: function(d, name, inputid){
        	
        	if($(inputid, this.$el).is(":checked")){
        		d[name] = "1";
        	}
        	else{
        		d[name] = "0";
        	}
        	
        },

		/**
		 * Clear the browser test connection.
		 */
		showBrowserHelp: function(){
			$("#browser-help-dialog", this.$el).modal();
			return false;
		},
		
		/**
		 * Clear the browser test connection link.
		 */
		clearTestBrowserLink: function(){
			$('#browserTestResults', this.$el).removeClass("browserChecking").removeClass("browserDoesntWork").removeClass("browserWorks").html("");
		},

		/**
		 * Test the browser connection.
		 */
		clickTestBrowser: function(){

			var args = {
				browser : $('#inputBrowser', this.$el).val()
			};

			// Update the icon accordingly
			this.clearTestBrowserLink();
			$('#browserTestResults', this.$el).addClass("browserChecking").html("Testing...");

        	// Get the results
        	$.ajax({
    			url: Splunk.util.make_full_url("/custom/website_input/web_input_controller/test_browser"),
    			data: args,
    			type: 'GET',
                success: function(result) {
                	
					if(result.success){
						$('#browserTestResults', this.$el).removeClass("browserChecking").addClass("browserWorks").html('<i class="icon-check"></i> Browser works!');
					}
					else{
						$('#browserTestResults', this.$el).removeClass("browserChecking").addClass("browserDoesntWork").html('<i class="icon-alert"></i> Browser didn\'t work :(');
					}

                	console.info("Successfully tested the browser");
                }.bind(this),
                error: function() {

                }.bind(this)
        	});

			return false;
		},

		/**
		 * Clear the browser test connection.
		 */
		clearDetectFieldsLink: function(){
			$('#detectFieldResults', this.$el).removeClass("detectFieldsChecking").removeClass("detectFieldsFailed").removeClass("detectFieldsWorked").html("");
		},

		/**
		 * Process the request to determine the form-fields.
		 */
		clickDetermineFormFields: function(e){
			this.determineFormFields(e, true);
			return false;
		},

		/**
		 * Determine the form fields.
		 */
		determineFormFields: function(e, force){

			// Assign a default to the force argument
			if(typeof force === 'undefined'){
				force = false;
			}

			// Stop if we don't have a URL
			if($('#inputLoginURL', this.$el).val().length === 0){
				return;
			}

			// Stop if we already have form fields and this isn't being forced
			if(!force && $('#inputUsernameField', this.$el).val().length > 0 && $('#inputPasswordField', this.$el).val().length > 0){
				return;
			}

			// Update the icon accordingly
			this.clearDetectFieldsLink();
			$('#detectFieldResults', this.$el).addClass("detectFieldsChecking").html("Detecting...");

			// Make the arguments
			var args = {
				url : $('#inputLoginURL', this.$el).val(),
				user_agent : $('#inputUserAgent', this.$el).val()
			};

        	// Get the results
        	$.ajax({
    			url: Splunk.util.make_full_url("/custom/website_input/web_input_controller/get_login_fields"),
    			data: args,
    			type: 'GET',
                success: function(result) {

					if(result.username_field && result.password_field){

						if(force || $('#inputUsernameField', this.$el).val() === ''){
							$('#inputUsernameField', this.$el).val(result.username_field);
						}
						
						if(force || $('#inputPasswordField', this.$el).val() === ''){
							$('#inputPasswordField', this.$el).val(result.password_field);
						}
						
						console.info("Successfully loaded the login form information");

						$('#detectFieldResults', this.$el).removeClass("detectFieldsChecking").addClass("detectFieldsWorked").html('<i class="icon-check"></i> Login fields detected');
					}
					else{
						$('#detectFieldResults', this.$el).removeClass("detectFieldsChecking").addClass("detectFieldsFailed").html('<i class="icon-alert"></i> Login fields could not be detected');
					}
                }.bind(this),
                error: function() {
					$('#detectFieldResults', this.$el).removeClass("detectFieldsChecking").addClass("detectFieldsFailed").html('<i class="icon-alert"></i> Login fields could not be detected');
                }.bind(this)
        	});

			return false;
		},
        
        /**
         * Show the results preview.
         */
        showResultsPreview: function(){
        	this.previewResultsView.updatePreview(this.makeConfig(true));
        },
        
        /**
         * Open a preview in search.
         */
        openPreviewInSearch: function(){
        	var config = this.makeConfig();
        	
        	var arg_str = "";
        	
        	// Make an array that can be used to drop fields or translate the names
        	var arguments_translation = {
        			'interval' : null,
        			'host' : null,
        			'index' : null,
        			'title' : null,
        			'name' : null,
					'output_results' : null,
					'username' : null,
					'password' : null,
					'username_field' : null,
					'password_field' : null,
					'authentication_url' : null
        	};
        	
        	// Make a list of the default arguments. If the argument match, then will be excluded from the search string (in order to make it simpler)
        	var default_arguments = {
        			 'timeout' : '5',
        			 'browser' : 'integrated_client',
        			 'user_agent' : 'Splunk Website Input (+https://splunkbase.splunk.com/app/1818/)',
        			 'page_limit' : '1',
        			 'depth_limit': '2',
        			 'raw_content' : '0',
        			 'output_as_mv' : '1',
        			 'use_element_name' : '0'
			};

        	// Make up the arguments
			for(var k in config){
				
				// Find the name of the field to translate to
				var translation = arguments_translation[k];
				
				// Don't include this variable if it should not be passed
				if(translation === null){
					continue;
				}
				
				// Otherwise, add the argument
				var value = config[k];
				var param_name = k;
				
				// Use the translated argument if necessary
				if(translation !== undefined){
					param_name = translation;
				}
				
				// If the argument matches the default anyways, then don't bother including it
				if(default_arguments[param_name] !== undefined && default_arguments[param_name] === value){
					// Ignore this one
				}
				
				// Add the argument and exclude the double quotes if it is an integer
				else if(value.length > 0 && /^[0-9]+$/gi.test(value)){
					arg_str = arg_str + param_name + '=' + value + ' ';
				}
				
				// Add the argument and include the double quotes to make sure 
				else if(value.length > 0){
					arg_str = arg_str + param_name + '="' + value + '" ';
				}
			}
			
			// Open the URL
			var url = "search?q=" + encodeURIComponent("| webscrape " + arg_str);
			var win = window.open(url, '_blank');
			win.focus();
        },
        
        /**
         * Render a list of URLs in the preview list
         */
        renderPreviewURLs: function(urls){
        	var html = "";
        	var option_template = _.template('<li><a href="#" data-url="<%- url %>" class="preview-url"><%- url %></a></li>');
        	
        	for(var c=0; c < urls.length; c++){
        		html += option_template({
        			"url" : urls[c]
        		})
        	}
        	
        	$('.preview-url-dropdown-selector').html(html);
        },
        
        /**
         * Update the list of preview URLs
         */
        updatePreviewURLs: function(){
        	
        	// Hide the spinner indicating that the preview URLs are loading
        	$('.preview-urls-loading', this.$el).show();
        	
        	// Make the args
        	var args = {};
        	
        	this.addIfInputIsNonEmpty(args, 'page_limit', '#inputPageLimit');
        	this.addIfInputIsNonEmpty(args, 'depth_limit', '#inputDepthLimit');
        	this.addIfInputIsNonEmpty(args, 'url_filter', '#inputURLFilter');
        	this.addIfInputIsNonEmpty(args, 'uri', '#inputURL');
        	this.addIfInputIsNonEmpty(args, 'page_limit', '#inputPageLimit');
        	this.addIfInputIsNonEmpty(args, 'browser', '#inputBrowser');
			this.addIfInputIsNonEmpty(args, 'timeout', '#inputTimeout');
			this.addIfInputIsNonEmpty(args, 'user_agent', '#inputUserAgent');

        	this.addIfInputIsNonEmpty(args, 'username', '#inputUsername');
        	this.addIfInputIsNonEmpty(args, 'password', '#inputPassword');
        	this.addIfInputIsNonEmpty(args, 'authentication_url', '#inputLoginURL');
			this.addIfInputIsNonEmpty(args, 'username_field', '#inputUsernameField');
			this.addIfInputIsNonEmpty(args, 'password_field', '#inputPasswordField');
        	
        	// Place a limit on the page count of 10
        	if(parseInt(args['page_limit'], 10) > 10){
        		args['page_limit'] = '10';
        	}
        	
        	// Get the results
        	$.ajax({
    			url: Splunk.util.make_full_url("/custom/website_input/web_input_controller/scrape_page"),
    			data: args,
    			type: 'POST',
                success: function(results) {
                	
                	// Get a list of the URLs
                	var urls = [];
                	
                	for(var c=0; c < results.length; c++){
                		urls.push(results[c]["url"]);
                	}
                	
                	// Render the URLs if we got some
                	if(urls.length > 0){
                		this.renderPreviewURLs(urls);
                	}
                	
                	// If we didn't get any, then just use the input URL
                	else{
                		this.renderPreviewURLs([$("#inputURL", this.$el).val()]);
                	}
                	
                	// Hide the message noting that we are getting the list of URLs
                	$('.preview-urls-loading', this.$el).hide();
                	
                	console.info("Successfully retrieved the preview URLs");
                }.bind(this),
                error: function() {
                	$('.preview-urls-loading', this.$el).hide();
                  console.error("Unable to fetch the results");
                }.bind(this)
        	});
        },
        
        /**
         * Set the input to the given value if it isn't null or undefined.
         */
        setIfValueIsNonEmpty: function(input, value){
        	if(value !== null && value !== undefined){
        		$(input, this.$el).val(value);
        	}
        },
        
        /**
         * Set the checkbox to the given value.
         */
        setCheckboxInput: function(input, value){
        	
        	// If the vlaue is a boolean already, then just assign it
        	if(value === true || value === false){
        		$(input, this.$el).prop('checked', value);
        		return;
        	}
        	
        	// Otherwise, handle the string values
        	if(value !== null && value !== undefined && (value === "1" || value.toLowerCase() === "true")){
        		$(input, this.$el).prop('checked', true);
        	}
        	else{
        		$(input, this.$el).prop('checked', false);
        	}
        },
        
        /**
         * Load the given input into the UI.
         */
        loadInput: function(input){
        	
        	// Generic options
        	//this.setIfValueIsNonEmpty(data, "source", '#inputSource');
        	if(input.content.name !== null){
        		 mvc.Components.getInstance("name").val(input.content.name);
        	}
        	
        	mvc.Components.getInstance("index").val(input.content.index);
        	mvc.Components.getInstance("host").val(input.content.host);
        	
        	if(input.content.sourcetype !== null){
        		mvc.Components.getInstance("sourcetype").val(input.content.sourcetype);
        	}
        	
        	// Input basics
        	this.setIfValueIsNonEmpty('#inputSelector', input.content.selector);
        	this.setIfValueIsNonEmpty('#inputURL', input.content.url);
        	this.setIfValueIsNonEmpty('#inputInterval', input.content.interval);
        	
        	if(input.content.title !== null){
        		mvc.Components.getInstance("title").val(input.content.title);
        	}
        	
        	// HTTP client
        	this.setIfValueIsNonEmpty('#inputTimeout', input.content.timeout);
        	this.setIfValueIsNonEmpty('#inputBrowser', input.content.browser);
        	this.setIfValueIsNonEmpty('#inputUserAgent', input.content.user_agent);
        	
        	// Crawling options
        	this.setIfValueIsNonEmpty('#inputPageLimit', input.content.page_limit);
        	this.setIfValueIsNonEmpty('#inputURLFilter', input.content.url_filter);
        	this.setIfValueIsNonEmpty('#inputDepthLimit', input.content.depth_limit);
        	
        	// Credentials
        	this.setIfValueIsNonEmpty('#inputUsername', input.content.username);
			this.setIfValueIsNonEmpty('#inputPassword', input.content.password);
        	this.setIfValueIsNonEmpty('#inputLoginURL', input.content.authentication_url);
			this.setIfValueIsNonEmpty('#inputUsernameField', input.content.username_field);
        	this.setIfValueIsNonEmpty('#inputPasswordField', input.content.password_field);
        	
        	// Output options
        	this.setIfValueIsNonEmpty('#inputNameAttributes', input.content.name_attributes);
        	this.setIfValueIsNonEmpty('#inputTextSeparator', input.content.text_separator);
        	
        	this.setCheckboxInput('#inputIncludeRaw', input.content.raw_content);
			this.setCheckboxInput('#inputIncludeEmpty', input.content.empty_matches);
        	this.setCheckboxInput('#inputMV', input.content.output_as_mv);
        	this.setCheckboxInput('#inputUseTagAsField', input.content.use_element_name);

			if(input.content.output_results !== null){
        		mvc.Components.getInstance("output_results").val(input.content.output_results);
        	}
        	
        },
        
        /**
         * Get the given input.
         */
        fetchInput: function(input_name, namespace, owner){
        	
        	// Set defaults for the owner and namespace arguments
        	if(typeof namespace === "undefined"){
        		var namespace = null;
        	}
        	
        	if(typeof owner === "undefined"){
        		var owner = null;
        	}
        	
        	// Make a promise
        	var promise = $.Deferred();
        	
        	// Prepare the arguments
            var params = {};
            params.output_mode = 'json';
            
            // Make the URI for getting the info
            var uri = splunkd_utils.fullpath("/services/data/inputs/web_input/" + input_name);
            
            if(owner !== null && namespace !== null){
            	uri = splunkd_utils.fullpath("/servicesNS/" + encodeURIComponent(owner) + "/" + encodeURIComponent(namespace) + "/data/inputs/web_input/" + encodeURIComponent(input_name));
            }
            
            uri += '?' + Splunk.util.propToQueryString(params);
            
            // Fire off the request
            jQuery.ajax({
                url:     uri,
                type:    'GET',
                success: function(result) {
                	
                    if(result !== undefined && result.isOk === false){
                    	console.error("Input could not be obtained: " + result.message);
                    	promise.reject();
                    }
                    else if(result === undefined || result === null){
                    	console.error("Input could not be obtained: result object is null or undefined");
                    	promise.reject();
                    }
                    else{
                    	input = result.entry[0];
                    	
                    	promise.resolve(input);
                    }
                }.bind(this),
                // On error
    			error: function(jqXHR, textStatus, errorThrown){
    				promise.reject();
    			}.bind(this)
            });
            
            return promise;

        },
        
        /**
         * Handle changes to the input selector.
         */
        changeInputSelector: function(ev){
        	this.refreshSelector($("#inputSelector").val());
        },
        
        /**
         * Handle enter key to the input selector.
         */
        keypressInputSelector: function(ev){
        	
        	var code = ev.keyCode || ev.which;
        	
            if (code == 13){
            	this.refreshSelector($("#inputSelector").val());
            }
        },

        
        /**
         * Update the count of matches.
         */
        updateMatchCount: function(){
        	
        	var matches = "";
        	
        	if($("#inputSelector", this.$el).val().trim().length > 0){
        		matches = $($("#inputSelector", this.$el).val(), frames[0].window.document).length;
        	}
        	
        	// If we got nothing, then blank out the match count
        	if(matches === ""){
        		$('.match-count', this.$el).text(matches);
        	}
        	
        	// If we got one, then use the singular form
        	else if(matches === 1){
        		$('.match-count', this.$el).text("1 match in the current document");
        	}
        	
        	else if(matches > 1 || matches === 0){
        		$('.match-count', this.$el).text(matches + " matches in the current document");
        	}
        	
        },
        
        /**
         * Update the selector in the preview panel.
         */
        refreshSelector: function(selector){
        	
        	// Update the selector gadget if it has been loaded
        	if(frames[0].window.selector_gadget){
        		$(frames[0].window.selector_gadget.path_output_field).val(selector);
            	frames[0].window.selector_gadget.refreshFromPath();
            	this.previous_sg_value = selector;
        	}
        	
        	// Update the count of matches
        	this.updateMatchCount();
        },
        
        /**
         * Clear the given selector.
         */
        clearSelector: function(){
        	$("#_sg_div > input:nth-of-type(2)", frames[0].window.document).trigger("click");
        },
        
        /**
         * Get the indexes
         */
        gotIndexes: function(){
        	
        	// Update the list
        	if(mvc.Components.getInstance("index")){
        		mvc.Components.getInstance("index").settings.set("choices", this.getChoices(this.indexes, function(entry){
        			return !(entry.attributes.name[0] === "_");
        		}));
        	}
        	
        },
        
        /**
         * Get the list of a collection model as choices.
         */
        getChoices: function(collection, filter_fx){
        	
        	// Make a default for the filter function
        	if(typeof filter_fx === 'undefined'){
        		filter_fx = null;
        	}
        	
        	// If we don't have the model yet, then just return an empty list for now
        	if(!collection){
        		return [];
        	}
        	
        	var choices = [];
        	
        	for(var c = 0; c < collection.models.length; c++){
        		
        		// Stop if the filtering function says not to include this entry
        		if(filter_fx && !filter_fx(collection.models[c].entry) ){
        			continue;
        		}
        		
        		// Otherwise, add the entry
        		choices.push({
        			'label': collection.models[c].entry.attributes.name,
        			'value': collection.models[c].entry.attributes.name
        		});
        	}
        	
        	return choices;
        	
        },
        
        /**
         * Switch styles on or off.
         */
        switchStyles: function(ev){
        	var style = $(ev.target).text();
        	
        	// Show the button as active on the selected entry and only on that entry
        	$('.switch-styles > .btn').each(function() {
        		if($(this).text() === style){
        			$(this).addClass('active');
        		}
        		else{
        			$(this).removeClass('active');
        		}
        	});
        	
        	// Update the URL
        	if(this.loaded_iframe_url !== null){
        		this.updatePreview(this.loaded_iframe_url);
        	}
        	else{
        		this.updatePreview($("#inputURL", this.$el).val());
        	}
        },
        
        /**
         * Handle the case where the preview button was clicked.
         */
        clickUpdatePreview: function(ev){
        	var url = $(ev.target).data("url");
        	this.updatePreview(url);
        	return true;
        },
        
        /**
         * Try to load the selector gadget in the preview window if necessary.
         */
        tryToLoadSelectorGadget: function(){
        	
        	// Stop if there is no iframe
        	if(frames.length === 0){
        		return;
        	}
        	
        	// Stop if the selector gadget successfully loaded
    		if(this.sg_loaded){
    			return;
    		}
    		
    		// See if the selector gadget exists
    		if(typeof frames[0].window.selector_gadget !== 'undefined'){
    			//clearInterval(this.selector_gadget_added_interval);
    			return;
    		}
    		
    		// See if the document is ready and update it if it is
    		if( (frames[0].window.document.readyState === 'loaded'
    			|| frames[0].window.document.readyState === 'interactive'
    			|| frames[0].window.document.readyState === 'complete')
    			&& frames[0].window.document.body !== null
    			&& frames[0].window.document.body.innerHTML.length > 0
    			&& typeof frames[0].window.selector_gadget === 'undefined' ){
    			
    			console.log("Loading the selector gadget into the preview frame")
    			this.startSelectorGadget();
    			this.sg_loaded = true;
    		}
        },
        
        /**
         * Update the preview panel.
         */
        updatePreview: function(url){
        	
        	// Remember the page we loaded in case someone asks to reload it
        	this.loaded_iframe_url = url;
        	
        	// Indicate that the selector gadget has not loaded yet
        	this.sg_loaded = false;
        	
        	// Clear the existing page so that it is clear that we are reloading the page
        	$("#preview-panel", this.$el).attr("src", "");
        	
        	// Stop if a URL was not provided
        	if(!url || url === ""){
        		return;
        	}
        	
        	// Indicate that the preview is loading
        	$('.page-preview-loading', this.$el).show();
        	
        	// Prepare the arguments
            var params = {};
            params.url = url;
            
            if( $('#inputUsername', this.$el).val().length > 0 && $('#inputPassword', this.$el).val().length > 0 ){
            	params.username = $('#inputUsername', this.$el).val();
            	params.password = $('#inputPassword', this.$el).val();
            }
            
            if( $('#inputBrowser', this.$el).val().length > 0 ){
            	params.browser = $('#inputBrowser', this.$el).val();
            }
            
            if( $('#inputTimeout', this.$el).val().length > 0 ){
            	params.timeout = $('#inputTimeout', this.$el).val();
            }
            
            if( $('.styles-off.active', this.$el).length > 0 ){
            	params.clean_styles = '1';
			}
			
        	this.addIfInputIsNonEmpty(params, 'authentication_url', '#inputLoginURL');
			this.addIfInputIsNonEmpty(params, 'username_field', '#inputUsernameField');
			this.addIfInputIsNonEmpty(params, 'password_field', '#inputPasswordField');

			this.addIfInputIsNonEmpty(params, 'user_agent', '#inputUserAgent');

            var uri = Splunk.util.make_url("/custom/website_input/web_input_controller/load_page");
            uri += '?' + Splunk.util.propToQueryString(params);
            
        	// Tell the iframe to load the URL
        	$("#preview-form", this.$el).attr("action", uri);
        	$('#form-key', this.$el).val(this.form_key);
        	$('#preview-form', this.$el).submit();
        	
        	// Get the selector that will hide the loading preview
        	var selector_to_hide_when_done = $('.page-preview-loading', this.$el);
        	
        	// Prevent links from working in the frame
        	$("iframe").load(function() {
        		selector_to_hide_when_done.hide();
        	    $("iframe").contents().find("a").each(function(index) {
        	        $(this).on("click", function(event) {
        	            event.preventDefault();
        	            event.stopPropagation();
        	        });
        	    });
        	    
        	    $("iframe").contents().find("form").each(function(index) {
        	        $(this).on("submit", function(event) {
        	            event.preventDefault();
        	            event.stopPropagation();
        	        });
        	    });
        	});
        	
        	
        	return;
        },
        
        /**
         * This is a helper function to create a step.
         */
        createStep: function(step) {
        	
            // Make the model that will store the steps if it doesn't exist yet
        	if(this.steps === undefined){
        		this.steps = new Backbone.Collection();
        	}
            
        	// This is the instance of your new step
            var newStep = {
                label: _(step.label).t(),
                value: step.value,
                showNextButton: step.showNextButton !== undefined ? step.showNextButton : true,
                showPreviousButton: step.showPreviousButton !== undefined ? step.showPreviousButton : true,
                showDoneButton: step.showDoneButton !== undefined ? step.showDoneButton : false,
                doneLabel: step.doneLabel || 'Done',
                enabled: true,
                panelID: step.panelID,
                validate: function(selectedModel, isSteppingNext) {
                	
                    var promise = $.Deferred();
                    
                    // Get the response from the validation attempt (if a validateStep function is defined)
                    var validation_response = true;
                    
                    if(typeof this.validateStep !== undefined){
                    	validation_response = this.validateStep(selectedModel, isSteppingNext);
                    }
                    
                    // Based on the validation action, reject or resolve the promise accordingly to let the UI know if the user should be allowed to go to the next step
                    if(validation_response === true){
                    	promise.resolve();
                    }
                    else if(validation_response === false){
                    	promise.reject();
                    }
                    else{
                    	return validation_response; // This is a promise
                    }
                    
                    return promise;
                    
                }.bind(this),
            };

            return newStep;
        },
        
        /**
         * Make the steps.
         */
        initializeSteps: function(){
        	
        	var c = 0;
        	
            // Make the model that will store the steps
            this.steps = new Backbone.Collection();
        	
            // Create the steps
        	
        	// Step 1
            this.steps.add(this.createStep({
                label: 'Enter URL',
                value: 'url-edit',
                showNextButton: true,
                showPreviousButton: false,
                panelID: "#url-edit"
            }), {at: ++c});

            // Step 2
            this.steps.add(this.createStep({
                label: 'Enter Credentials',
                value: 'auth-edit',
                showNextButton: true,
                showPreviousButton: true,
                panelID: "#auth-edit"
            }), {at: ++c}); 
            
            // Step 3
            this.steps.add(this.createStep({
                label: 'Define CSS Selector',
                value: 'selector-edit',
                showNextButton: true,
                showPreviousButton: true,
                panelID: "#selector-edit"
            }), {at: ++c}); 
            
            // Step 4
            this.steps.add(this.createStep({
                label: 'Customize Output',
                value: 'output-edit',
                showNextButton: true,
                showPreviousButton: true,
                panelID: "#output-edit"
            }), {at: ++c});
            
            // Step 5
            this.steps.add(this.createStep({
                label: 'Define Input Settings',
                value: 'index-edit',
                showNextButton: true,
                showPreviousButton: true,
                panelID: "#index-edit"
            }), {at: ++c});
            
            // Step 6
            this.steps.add(this.createStep({
                label: 'Save Input',
                value: 'name-edit',
                showNextButton: true,
                showPreviousButton: true,
                panelID: "#name-edit"
            }), {at: ++c}); 
            
            // Step 7
            this.steps.add(this.createStep({
                label: 'Finish',
                value: 'final',
                showNextButton: false,
                showPreviousButton: false,
                showDoneButton: true,
                panelID: "#final"
            }), {at: ++c});  
        },
        
        /**
         * Clear the validation error.
         */
        clearValidationError: function(inputID){
        	// Remove the error class
        	$(inputID).parent().parent().removeClass("error");
        },
        
        /**
         * Clear all validation errors.
         */
        clearValidationErrors: function(){
        	
        	// Remove the error class
        	$.each( $('input'), function( i, val ) {
        		
        		// Make sure this is a control group
        		if($(val).parent().parent().hasClass("control-group")){
            		// Remove the error class
            		$(val).parent().parent().removeClass("error");
            		
            		// Clear the error message
            		$('.help-inline', $(val).parent()).text("");
        		}

        	});
        },
        
        /**
         * Add the validation error.
         */
        addValidationError: function(inputID, message){
        	
        	// Add the error class to the 
        	$(inputID).parent().parent().addClass("error");
        	
        	// Determine if the input has the inline help box
        	if($(".help-inline", $(inputID).parent()).length === 0){
        		
        		// Add the inline help box
            	$('<span class="help-inline"></span>').insertAfter(inputID)
        	}
        	
        	// Set the message
        	$(".help-inline", $(inputID).parent()).text(message);
        	
        },
        
        /**
         * Validate that changing steps is allowed.
         */
        validateStep: function(selectedModel, isSteppingNext){
        	
        	// Get the copy of the config
        	var data = this.makeConfig();
        	
        	var issues = 0;
			
        	// Clear existing validation errors
        	this.clearValidationErrors();
			
        	// Validate step 1
        	// Update the preview URLs if moving from the URL step
        	if(selectedModel.get("value") === 'url-edit' && isSteppingNext){
        		
        		// Validate the interval
        		if(!this.isValidInterval($("#inputInterval").val())){
        			this.addValidationError($("#inputInterval"), "Enter a valid interval");
        			issues += 1;
        		}
        		
        		// Validate the URL
        		if($("#inputURL").val().length === 0){
        			this.addValidationError($("#inputURL"), "Enter a valid URL");
        			issues += 1;
				}
				else if(this.is_on_cloud && !$("#inputURL").val().startsWith("https://")){
					this.addValidationError($("#inputURL"), "Enter a URL that uses HTTPS (only HTTPS is allowed on cloud)");
        			issues += 1;
				}
				else if(!this.is_on_cloud && !$("#inputURL").val().startsWith("https://") && !$("#inputURL").val().startsWith("http://")){
					this.addValidationError($("#inputURL"), "Enter a valid URL with either the HTTP or HTTPS protocol");
        			issues += 1;
				}

        		// Validate the depth limit
        		if($("#inputDepthLimit").val().length !== 0 && $("#inputDepthLimit").val().match(/^[0-9]+$/gi) === null){
        			this.addValidationError($("#inputDepthLimit"), "Enter a valid integer");
        			issues += 1;
        		}
        		
        		// Validate the page limit
        		if($("#inputPageLimit").val().length !== 0 && $("#inputPageLimit").val().match(/^[0-9]+$/gi) === null){
        			this.addValidationError($("#inputPageLimit"), "Enter a valid integer");
        			issues += 1;
        		}
        		
        		// Validate the URL filter
        		// TODO
        		
        		// Validate the timeout
        		if($("#inputTimeout").val().length !== 0 && $("#inputTimeout").val().match(/^[0-9]+$/gi) === null){
        			this.addValidationError($("#inputTimeout"), "Enter a valid integer");
        			issues += 1;
				}
				
				// Hide the browser options if necessary
				if($('#inputBrowser').val() === 'integrated_client'){
					$('.hide-when-using-browser', this.$el).show();
				}
				else{
					$('.hide-when-using-browser', this.$el).hide();
				}
        	}
        	
        	// Validate step 2
        	if(selectedModel.get("value") === 'auth-edit' && isSteppingNext){

				// Validate the login form URL

				// Make sure it looks like a URL (has a protocol)
				if(this.is_on_cloud && $("#inputLoginURL").val().length !== 0 && !$("#inputLoginURL").val().startsWith("https://")){
					this.addValidationError($("#inputLoginURL"), "Enter a URL that uses HTTPS (only HTTPS is allowed on cloud)");
        			issues += 1;
				}
				else if(!this.is_on_cloud && $("#inputLoginURL").val().length !== 0 && !$("#inputLoginURL").val().startsWith("https://") && !$("#inputLoginURL").val().startsWith("http://")){
					this.addValidationError($("#inputLoginURL"), "Enter a valid URL with either the HTTP or HTTPS protocol");
        			issues += 1;
				}
				// Make sure it only uses 
				else if(($("#inputLoginURL").val().length !== 0 || $("#inputPasswordField").val().length !== 0) && $("#inputLoginURL").val().length === 0){
					this.addValidationError($("#inputLoginURL"), "Enter a URL of the login page");
        			issues += 1;
				}
				else{
					this.updatePreview($("#inputURL", this.$el).val());
					this.renderPreviewURLs([$("#inputURL", this.$el).val()]);
					this.updatePreviewURLs();
					this.clearDetectFieldsLink();
				}

        	}
        	
        	// Validate step 3
        	
        	// Validate step 4
        	
        	// Validate step 5
        	
        	// Validate step 6, complete save
        	if(selectedModel.get("value") === 'name-edit' && isSteppingNext){
        		var promise = $.Deferred();
            	
        		$.when(this.saveInput(data)).then(function(){
        			//promise.resolve();
        		})
				.then(this.savePassword(data['name'])).then(function(){
        			promise.resolve();
        		})
        		.fail(function(msg){
        			alert("The input could not be saved: " + msg);
        			promise.reject();
        		});
        		
            	return promise;
        	}
        	
        	// Stop if issues are found
    		if(issues > 0){
    			return false;
    		}
    		else{
    			return true;
    		}
        },
        
        /**
         * Setup the step wizard.
         */
        setupStepWizard: function(initialStep){
        	
        	var wizard = new Backbone.Model({
                'currentStep': initialStep
              });

              wizard.on('change:currentStep', function(model, currentStep) {
                  this.steps.map(function(step){
                      step.stopListening();
                  }.bind(this));
                  
                  // Find the associated step model
                  var step = this.steps.find(function(step) {
                      return step.get('value') == currentStep;
                  });

                  // Show or hide the next button as necessary
                  if (step.get('showNextButton')) {
                      $('button.btn-next', this.$el).show();
                  } else {
                      $('button.btn-next', this.$el).hide();
                  }

                  // Show or hide the previous button as necessary
                  if (step.get('showPreviousButton')) {
                      $('button.btn-prev', this.$el).show();
                  } else {
                      $('button.btn-prev', this.$el).hide();
                  }

                  // Show or hide the done button as necessary
                  if (step.get('showDoneButton')) {
                      $('button.btn-finalize', this.$el).show();
                      $('button.btn-finalize', this.$el).text(step.get('doneLabel'));
                  } else {
                      $('button.btn-finalize', this.$el).hide();
                  }

                  // Hide all of the existing wizard views
                  $(".wizard-content", this.$el).hide();
                  
                  // Show the next panel
                  $(step.get('panelID'), this.$el).show();
                  
              }.bind(this));
              
              // This is just the initial hidden step
              this.steps.unshift({
                  label: "",
                  value: 'initial',
                  showNextButton: false,
                  showPreviousButton: false,
                  enabled: false,
              });
              
              // Create the step wizard control
              this.stepWizard = new StepWizardControl({
                  model: wizard,
                  modelAttribute: 'currentStep',
                  collection: this.steps,
              });
              
              // Render the step wizard
              $('#step-control-wizard', this.$el).append(this.stepWizard.render().el);
              
              // Hide all of the existing wizard views
              $(".wizard-content", this.$el).hide();
              
              // Go the initial step: find it first
              var initialStep = this.steps.find(function(step) {
                  return step.get('value') == initialStep;
              });
              
              // ... now show it
              $(initialStep.get('panelID'), this.$el).show();
              
              // Go to step one
              this.stepWizard.step(1);
        },
        
        /**
         * Parses a URL into chunks. See https://gist.github.com/jlong/2428561
         */
        parseURL: function(url){
        	var parser = document.createElement('a');
        	parser.href = url;

        	/*
        	parser.protocol; // => "http:"
        	parser.hostname; // => "example.com"
        	parser.port;     // => "3000"
        	parser.pathname; // => "/pathname/"
        	parser.search;   // => "?search=test"
        	parser.hash;     // => "#hash"
        	parser.host;     // => "example.com:3000"
        	*/
        	
        	return parser;
        },
        
        /**
         * Make a stanza name from a string.
         */
        generateStanzaFromString: function(str, existing_stanzas){
        
        	// Stop of the string is blank
        	if(str === undefined || str === null || str === ""){
        		return "";
        	}
        	
        	// Set a default value for the existing_stanzas argument
        	if( typeof existing_stanzas == 'undefined' || existing_stanzas === null){
        		existing_stanzas = [];
        	}
        	
        	// If we have no existing stanzas, then just make up a name and go with it
        	if(existing_stanzas.length === 0){
            	return str.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
        	}
        	
        	var stanza_base = str.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
        	var possible_stanza = stanza_base;
        	var stanza_suffix_offset = 0;
        	var collision_found = false;
        	
        	while(true){
        		
        		collision_found = false;
        		
        		// See if we have a collision
            	for(var c = 0; c < existing_stanzas.length; c++){
            		if(existing_stanzas[c] === possible_stanza){
            			collision_found = true;
            			break;
            		}
            	}
        		
            	// Stop if we don't have a collision
            	if(!collision_found){
            		return possible_stanza;
            	}
            	
            	// We have a collision, continue
            	else{
            		stanza_suffix_offset = stanza_suffix_offset + 1;
            		possible_stanza = stanza_base + "_" + stanza_suffix_offset;
            	}
        		    		
        	}
        },
        
        /**
         * Generate a suggested title from the URL.
         */
        generateTitleFromURL: function(url){
        	var parsed = this.parseURL(url);
        	return parsed.hostname;
        },
        
        /**
         * Generate a suggested stanza from the URL.
         */
        generateStanzaFromURL: function(url, existing_stanzas){
        	
        	var parsed = this.parseURL(url);
        	
        	return this.generateStanzaFromString(parsed.hostname);
		},
		
        /**
         * Get the proposed filter from the URL.
         */
        generateFilterFromURL: function(url){
        	
			var parsed = this.parseURL(url);
			
			var url_filter = parsed.protocol + '//' + parsed.hostname;

			if(parsed.port !== ""){
				url_filter = url_filter + ":" + parsed.port;
			}

			return url_filter + "/*";
		},


		/**
		 * Suggest a URL filter if necessary.
		 */
		changeInputSelector: function(){
			if($('#inputURLFilter', this.$el).val().length !== 0){
				// Ignore, the filter already exists
			}
			else if(parseInt($('#inputPageLimit', this.$el).val(), 10) <= 1){
				// Ignore, no filter is needed
			}
			else if($('#inputURL', this.$el).val().length <= 0){
				// Ignore, no URL defined
			}
			else if($('#inputURL', this.$el).val().indexOf('http') === 0 && this.isValidURL($('#inputURL', this.$el).val())){
				$('#inputURLFilter', this.$el).val(this.generateFilterFromURL($('#inputURL', this.$el).val()));
			}
		},

		/**
		 * Suggest a URL filter if necessary.
		 */
		suggestURLFilter: function(){
			if($('#inputURL', this.$el).val().length <= 0){
				// No URL is defined, ignore for now
			}
			else if($('#inputURL', this.$el).val().indexOf('http') === 0 && this.isValidURL($('#inputURL', this.$el).val())){
				$('#inputURLFilter', this.$el).val(this.generateFilterFromURL($('#inputURL', this.$el).val()));
			}

			return false;
		},
        
        /**
         * Get a list of the existing inputs.
         */
        getExistingInputs: function(){

        	var uri = splunkd_utils.fullpath("/services/data/inputs/web_input?output_mode=json");

	        // Fire off the request
        	jQuery.ajax({
        		url:     uri,
        		type:    'GET',
        		async:   false,
        		success: function(result) {
        			
        			if(result !== undefined){
        				this.inputs = result.entry;
        			}
        			
        			// Populate a list of the existing input names
        			this.existing_input_names = [];
        			
                	for(var c = 0; c < this.inputs.length; c++){
                		this.existing_input_names.push(this.inputs[c]["name"]);
                	}

        		}.bind(this)
        	});

        },
        
        /**
         * Add the given item to the associative array if it is non-blank
         */
        addIfNonEmpty: function(d, name, value){
        	
        	if(value){
        		d[name] = value;
        	}
        	
        },
        
        /**
         * Make an associative array representing the configuration that is being requested to persist.
         */
        makeConfig: function(include_password){

			if(typeof include_password === 'undefined'){
				include_password = false;
			}
        	
        	// Make the data that will be posted to the server
        	var data = {};
        	
        	// Generic options
        	//this.addIfInputIsNonEmpty(data, "source", '#inputSource');
        	if(this.isNew() && mvc.Components.getInstance("name").val()){
        		data['name'] = mvc.Components.getInstance("name").val();
        	}
        	
        	if(mvc.Components.getInstance("index").val()){
        		data['index'] = mvc.Components.getInstance("index").val();
        	}
        	
        	if(mvc.Components.getInstance("host").val()){
        		data['host'] = mvc.Components.getInstance("host").val();
        	}
        	
        	if(mvc.Components.getInstance("sourcetype").val()){
        		data['sourcetype'] = mvc.Components.getInstance("sourcetype").val();
        	}
        	
        	// Input basics
        	this.addIfInputIsNonEmpty(data, "selector", '#inputSelector');
        	this.addIfInputIsNonEmpty(data, "url", '#inputURL');
        	this.addIfInputIsNonEmpty(data, "interval", '#inputInterval');
        	if(mvc.Components.getInstance("title").val()){
        		data['title'] = mvc.Components.getInstance("title").val();
        	}
        	
        	// HTTP client
        	this.addIfInputIsNonEmpty(data, "timeout", '#inputTimeout');
        	this.addIfInputIsNonEmpty(data, "browser", '#inputBrowser');
        	this.addIfInputIsNonEmpty(data, "user_agent", '#inputUserAgent');
        	
        	// Crawling options
        	this.addIfInputIsNonEmpty(data, "page_limit", '#inputPageLimit');
        	this.addIfInputIsNonEmpty(data, "url_filter", '#inputURLFilter');
        	this.addIfInputIsNonEmpty(data, "depth_limit", '#inputDepthLimit');
        	
        	// Credentials
			this.addIfInputIsNonEmpty(data, "username", '#inputUsername');
			if(include_password){
				this.addIfInputIsNonEmpty(data, "password", '#inputPassword');
			}
			else{
				data.password = ""; // Clear the password, it should be stored in secure storage
			}
			this.addIfInputIsNonEmpty(data, "authentication_url", '#inputLoginURL');
			this.addIfInputIsNonEmpty(data, "username_field", '#inputUsernameField');
			this.addIfInputIsNonEmpty(data, "password_field", '#inputPasswordField');
        	
        	// Output options
        	this.addIfInputIsNonEmpty(data, "name_attributes", '#inputNameAttributes');
        	this.addIfInputIsNonEmpty(data, "text_separator", '#inputTextSeparator');
        	
        	this.addCheckboxInput(data, "raw_content", '#inputIncludeRaw');
			this.addCheckboxInput(data, "empty_matches", '#inputIncludeEmpty');
        	this.addCheckboxInput(data, "output_as_mv", '#inputMV');
        	this.addCheckboxInput(data, "use_element_name", '#inputUseTagAsField');
			//data.output_results = $('#inputOutputResults').val();
			if(mvc.Components.getInstance("output_results").val()){
        		data['output_results'] = mvc.Components.getInstance("output_results").val();
        	}
        	
        	// Populate defaults for the arguments
        	if(!data.hasOwnProperty('name') && this.isNew()){
        		data['name'] = this.generateStanzaFromURL(data['url'], this.existing_input_names);
        	}
        	
        	if(!data.hasOwnProperty('title')){
        		data['title'] = this.generateTitleFromURL(data['url']);
        	}
        	
        	return data;
        },
        
		/**
		 * Save the password
		 */
        savePassword: function(name){
            var password = $('#inputPassword', this.$el).val();

			var stanza_name;
			if(name !== undefined){
				stanza_name = name;
			}
			else{
				stanza_name = this.fetched_input_name;
			}

            // Delete the secured password if the password was cleared
            if(password.length === 0){
				// Get the stanza name
				secure_storage_stanza = this.makeStorageEndpointStanza(this.options.secure_storage_username, this.options.secure_storage_realm_prefix + stanza_name);
                return this.deleteEncryptedCredential(secure_storage_stanza, true);
            }
            // Otherwise, update it
            else{
                return this.saveEncryptedCredential(this.options.secure_storage_username, password, this.options.secure_storage_realm_prefix + stanza_name);
            }
        },

        /**
         * Save the input config entry
         */
        saveInput: function(config){
        	
        	// Get a promise ready
        	var promise = jQuery.Deferred();
        	
        	// Prepare the arguments
            var params = {};
            params.output_mode = 'json';
        	
        	var uri = splunkd_utils.fullpath("/servicesNS/admin/website_input/data/inputs/web_input");
        		
        	// If we are editing an existing input, then post to the existing entry
        	if(this.fetched_input_name !== null && this.fetched_input_name !== "_new"){
        		uri = splunkd_utils.fullpath("/servicesNS/" + encodeURIComponent(this.fetched_input_owner) + "/" + encodeURIComponent(this.fetched_input_namespace) + "/data/inputs/web_input/" + encodeURIComponent(this.fetched_input_name));
        	}
        	
            uri += '?' + Splunk.util.propToQueryString(params);
            
        	// Perform the call
        	$.ajax({
        			url: uri,
        			data: config,
        			type: 'POST',
        			
        			// On success
        			success: function(data) {
        				console.info('Input saved');
        				
        				var app = data.entry[0].acl.app;
        				var owner = data.entry[0].acl.owner;
        				var name = data.entry[0].name;
        				
        			}.bind(this),
        		  
        			// On complete
        			complete: function(jqXHR, textStatus){
        				
        				// Handle cases where the input already existing or the user did not have permissions
        				if( jqXHR.status == 403){
        					console.info('Inadequate permissions');
        					this.showWarningMessage("You do not have permission to make inputs");
        				}
        				else if( jqXHR.status == 409){
        					console.info('Input already exists');
        				}
        				
        				promise.resolve();
        			  
        			}.bind(this),
        		  
        			// On error
        			error: function(jqXHR, textStatus, errorThrown){
        				
        				// Handle the case where the user lacks permission
        				if( jqXHR.status === 403){
        					promise.reject("You do not have permission to make inputs");
        				}
        				
        				// Handle the case where the name already exists
        				else if( jqXHR.status === 409 ){
        					promise.reject("An input with the given name already exists");
        				}
        				
        				// Handle general errors
        				else{
        					promise.reject("An error occurred");
        				}
        				
    					
        			}.bind(this)
        	});
        	
        	return promise;
        },
        
        /**
         * Validate the inputs.
         */
        validate: function(){
        	
        	var issues = 0;
        	
        	return issues === 0;
        },
        
        /**
         * Returns true if the item is a valid URL.
         */
        isValidURL: function(url){
        	var regex = /^(https?:\/\/)?([\da-z\.-]+)([:][0-9]+)?([\/\w \.-]*)*\/?$/gi;
        	return regex.test(url);
        },
        
        /**
         * Returns true if the item is a valid interval.
         */
        isValidInterval: function(interval){
        	
        	var re = /^\s*([0-9]+([.][0-9]+)?)\s*([dhms])?\s*$/gi;
        	
        	if(re.exec(interval)){
        		return true;
        	}
        	else{
        		return false;
        	}
        },
        
        /**
         * Ensure that the tag is a valid URL.
         */
        validateURL: function(event) {
        	if(!this.isValidURL(event.item)){
        		
        		// Try adding the protocol to see if the user just left that part out.
        		if(this.isValidURL("http://" + event.item)){
        			$("#urls").tagsinput('add', "http://" + event.item);
        		}
        		
        		event.cancel = true;
        		
        	}
        },
        
        /**
         * Hide the given item while retaining the display value
         */
        hide: function(selector){
        	selector.css("display", "none");
        	selector.addClass("hide");
        },
        
        /**
         * Un-hide the given item.
         * 
         * Note: this removes all custom styles applied directly to the element.
         */
        unhide: function(selector){
        	selector.removeClass("hide");
        	selector.removeAttr("style");
        },
        
        /**
         * Hide the messages.
         */
        hideMessages: function(){
        	this.hideWarningMessage();
        	this.hideInfoMessage();
        },
        
        /**
         * Hide the warning message.
         */
        hideWarningMessage: function(){
        	this.hide($("#warning-message", this.$el));
        },
        
        /**
         * Hide the informational message
         */
        hideInfoMessage: function(){
        	this.hide($("#info-message", this.$el));
        },
        
        /**
         * Show a warning noting that something bad happened.
         */
        showWarningMessage: function(message){
        	$("#warning-message > .message", this.$el).text(message);
        	this.unhide($("#warning-message", this.$el));
        },
        
        /**
         * Show a warning noting that something bad happened.
         */
        showInfoMessage: function(message){
        	$("#info-message > .message", this.$el).text(message);
        	this.unhide($("#info-message", this.$el));
        },
        
        /**
         * Determine if the user has the given capability.
         */
        hasCapability: function(capability){

        	var uri = Splunk.util.make_url("/splunkd/__raw/services/authentication/current-context?output_mode=json");

        	if(this.capabilities === null){

	            // Fire off the request
	            jQuery.ajax({
	            	url:     uri,
	                type:    'GET',
	                async:   false,
	                success: function(result) {

	                	if(result !== undefined){
	                		this.capabilities = result.entry[0].content.capabilities;
	                	}

	                }.bind(this)
	            });
        	}

			// See if the user is running the free license
			if(this.capabilities.length === 0 && this.is_using_free_license === null){

				uri = Splunk.util.make_url("/splunkd/__raw/services/licenser/groups/Free?output_mode=json");

				// Do a call to see if the host is running the free license
	            jQuery.ajax({
	            	url:     uri,
	                type:    'GET',
	                async:   false,
	                success: function(result) {

	                	if(result !== undefined){
	                		this.is_using_free_license = result.entry[0].content['is_active'];
	                	}
						else{
							this.is_using_free_license = false;
						}

	                }.bind(this)
	            });
			}

			// Determine if the user should be considered as having access
			if(this.is_using_free_license){
				return true;
			}
			else{
				return $.inArray(capability, this.capabilities) >= 0;
			}

        },
        
        /**
         * Synchronize the selector gadget back with the input in the editor if needed.
         */
        syncSelectorGadget: function(){
        	
        	// Stop if there is no iframe
        	if(frames.length === 0){
        		return;
        	}
        	
        	// Stop if the selector gadget isn't initialized
        	if($("#_sg_path_field", frames[0].window.document).length === 0){
        		this.previous_sg_value = null;
        		return;
        	}
        	
    		// Get the current value
    		var value = $("#_sg_path_field", frames[0].window.document).val();
    		
    		// If we haven't set the value, then this means that the selector gadget has just been initialized. Sync the form element back to selector gadget.
    		if(this.previous_sg_value === null){
    			this.refreshSelector($("#inputSelector", this.$el).val());
    			return;
    		}
    		
    		// Do something since the value changed
    		if(value !== this.previous_sg_value){
    			
        		// See if the value is blank
        		if(value === "No valid path found."){
        			if($("#inputSelector", this.$el).val() !== ""){
        				$("#inputSelector", this.$el).val("");
        	        	this.updateMatchCount();
        			}
        		}
        		
        		// Otherwise, do something since the value changed
        		else if($("#inputSelector", this.$el).val() !== value){
        			$("#inputSelector", this.$el).val(value);
        			this.updateMatchCount();
        		}
        		
        		this.previous_sg_value = value;
    		}
        },
        
        /**
         * Import JS into the iframe.
         */
        importJS: function(src, look_for, onload) {
        	  var s = document.createElement('script');
        	  s.setAttribute('type', 'text/javascript');
        	  s.setAttribute('src', src);
        	  
        	  if (onload){
        		  this.waitForScriptLoad(look_for, onload);
        	  }
        	  
        	  var head = frames[0].window.document.getElementsByTagName('head')[0];
        	  
        	  if (head) {
        		  head.appendChild(s);
        	  } else {
        		  frames[0].window.document.body.appendChild(s);
        	  }
        },
        
        /**
         * Import CSS into the iframe.
         */
        importCSS: function(href, look_for, onload) {
        	  var s = frames[0].window.document.createElement('link');
        	  s.setAttribute('rel', 'stylesheet');
        	  s.setAttribute('type', 'text/css');
        	  s.setAttribute('media', 'screen');
        	  s.setAttribute('href', href);
        	  
        	  if (onload){
        		  this.waitForScriptLoad(look_for, onload);
        	  }
        	  
        	  var head = frames[0].window.document.getElementsByTagName('head')[0];
        	  
        	  if (head) {
        		  head.appendChild(s);
        	  } else {
        		  frames[0].window.document.body.appendChild(s);
        	  }
        },
        
        /**
         * Wait for a script load to happen in the iframe.
         */
        waitForScriptLoad: function(look_for, callback) {
        	  var interval = setInterval(function() {
        	    if (frames[0].window.eval("typeof " + look_for) != 'undefined') {
        	      clearInterval(interval);
        	      callback();
        	    }
        	  }, 50);
        },
        
        /**
         * Start the selector gadget in the iframe.
         */
        startSelectorGadget: function(){
        	
        	// Make the base URL for where the static files will be loaded from
        	var base_url = document.location.origin + Splunk.util.make_url("/static/app/website_input/js/lib/selectorgadget/");
        	
        	// Load a function that will make the i18n_register() calls not fail
        	frames[0].window.eval('function i18n_register(){};');
        	
        	// Make the base URL 
        	var base_url = document.location.origin + Splunk.util.make_url("/static/app/website_input/js/lib/selectorgadget") + "/";
        	
        	// Import the CSS
        	this.importCSS(base_url + "selectorgadget_custom.css");
        	
        	// Import the JS
        	this.importJS(base_url + "jquery.min.js", "jQuery",
        		function(){
		        	jQuery.noConflict();
		        	this.importJS(base_url + "diff_match_patch.js", "diff_match_patch",
		        		function(){
		        			this.importJS(base_url + "dom.js", "DomPredictionHelper",
		        				function(){
		        					this.importJS(base_url + "interface.js");
		        				}.bind(this)
		        			);
		        		}.bind(this)
		        	);
        		}.bind(this)
        	);
        	
        	// Clear the selector
        	this.previous_sg_value = null;
        },
        
        /**
         * Get the selector from the gadget in the 
         */
        getSelectorFromGadget: function(){
        	return $("#preview-panel").contents().find("#_sg_path_field");
        },
        
        /**
         * Determine if this is editing a new entry or an existing one.
         */
        isNew: function(){
        	if(this.fetched_input_name === null || this.fetched_input_name === "_new"){
        		return true;
        	}
        	else{
        		return false;
        	}
        },
        
        /**
         * Render the view.
         */
        render: function () {
        	
        	var has_permission = this.hasCapability('edit_modinput_web_input');

			if(this.is_on_cloud === null){
				this.server_info = new ServerInfo();
			}
			
			new ServerInfo().fetch().done(function(model){

				if(model.entry[0].content.instance_type){
					this.is_on_cloud = model.entry[0].content.instance_type === 'cloud';
				}
				else{
					this.is_on_cloud = false;
				}
				
				this.$el.html(_.template(Template, {
					'has_permission' : has_permission,
					'is_on_cloud': this.is_on_cloud
				}));
				
				// Make an instance of the results preview modal
				this.previewResultsView = new PreviewWebsiteInputResultsView({
					el: $('#preview-results-modal-holder', this.$el)
				});
				
				// Make the indexes selection drop-down
				var indexes_dropdown = new DropdownInput({
					"id": "index",
					"selectFirstChoice": false,
					"showClearButton": true,
					"el": $('#inputIndexes', this.$el),
					"choices": this.getChoices(this.indexes)
				}, {tokens: true}).render();
				
				// Make the sourcetype input
				var sourcetype_input = new TextInput({
					"id": "sourcetype",
					"searchWhenChanged": false,
					"el": $('#inputSourcetype', this.$el)
				}, {tokens: true}).render();
				
				// Make the host input
				var host_input = new TextInput({
					"id": "host",
					"searchWhenChanged": false,
					"el": $('#inputHost', this.$el)
				}, {tokens: true}).render();
				
				// Make the title input
				var title_input = new TextInput({
					"id": "title",
					"searchWhenChanged": false,
					"el": $('#titleInput', this.$el)
				}, {tokens: true}).render();
				
				// Generate a name from the title if the name is blank
				title_input.on("change", function(newValue) {
					if(!mvc.Components.getInstance("name").val() && newValue !== ""){
						mvc.Components.getInstance("name").val(this.generateStanzaFromString(newValue));
					}
				}.bind(this));
				
				// Make the name input
				var name_input = new TextInput({
					"id": "name",
					"searchWhenChanged": false,
					"el": $('#nameInput', this.$el)
				}, {tokens: true}).render();

				// Make the output_results selection drop-down
				var output_results_dropdown = new DropdownInput({
					"id": "output_results",
					"selectFirstChoice": false,
					"showClearButton": false,
					"el": $('#inputOutputResults', this.$el),
					"choices": [{
						'label': 'Always',
						'value': 'always'
					},
					{
						'label': 'Only when the matches change',
						'value': 'when_matches_change'
					},
					{
						'label': 'Only when the contents of the raw web-pages change',
						'value': 'when_contents_change'
					}]
				}, {tokens: true}).render();
				
				// Initialize the steps model
				this.initializeSteps();
				
				// Create the step wizard and set the initial step as the "url-edit" step
				this.setupStepWizard('url-edit');
				
				// Render the input entry
				// Fetch the default information
				if(Splunk.util.getParameter("name")){
					
					var secure_storage_stanza = this.makeStorageEndpointStanza(this.options.secure_storage_username, this.options.secure_storage_realm_prefix + Splunk.util.getParameter("name"));

					$.when(
						this.fetchInput(decodeURIComponent(Splunk.util.getParameter("name")),
										decodeURIComponent(Splunk.util.getParameter("namespace")),
										decodeURIComponent(Splunk.util.getParameter("owner"))),
						this.getEncryptedCredential(secure_storage_stanza, true)
											).done(
											function(input, credential){
												console.info("Successfully retrieved the input");
												this.loaded_input = input;
												this.loadInput(this.loaded_input);
												
												// Remember the parameters of what we loaded
												this.fetched_input_name = decodeURIComponent(Splunk.util.getParameter("name"));
												this.fetched_input_owner = decodeURIComponent(Splunk.util.getParameter("owner"));
												this.fetched_input_namespace = decodeURIComponent(Splunk.util.getParameter("namespace"));
												
												// Hide items only intended for new entries
												$('.hide-if-existing', this.$el).hide();

												// Load the credential
												if(credential){
														$('#inputPassword', this.$el).val(credential.entry.content.attributes.clear_password);
												}
											}.bind(this)
											).fail(
												function(msg){
													console.error("Failed to retrieve the input");
													$('#input-not-loaded', this.$el).show();
													$('#step-control-wizard', this.$el).hide();
													$('.wizard-content', this.$el).hide();
												}.bind(this)
											);
				}
				else{
					
					this.fetched_input_name = null;
					this.fetched_input_namespace = null;
					this.fetched_input_owner = null;
					
					$.when(this.fetchInput("_new")).done(function(input){
						console.log("Got the _new input");
						this.loaded_input = input;
						this.loadInput(this.loaded_input);
					}.bind(this));
				}
			}.bind(this));
        }
    });
    
    return WebsiteInputCreateView;
});